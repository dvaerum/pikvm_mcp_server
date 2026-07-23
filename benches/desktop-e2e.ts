/**
 * Desktop end-to-end harness (absolute-mouse path).
 *
 * The FIRST desktop e2e the project has ever had — desktop-support gap #1 was
 * "unmeasured reliability: no desktop e2e exists" (see
 * docs/desktop-support-gap-analysis.md). This exercises exactly the clean
 * desktop flow the gap analysis recommends:
 *
 *   auto_calibrate  →  mouse_move(x,y) at a grid of targets  →  motion-diff
 *   verify where the cursor landed  →  (optional) click + verify screen change
 *
 * It is CURSOR-AGNOSTIC (motion diff, like auto_calibrate) — no orange-cursor ML,
 * no iPad relative mover — so it works on a black desktop arrow. It needs a real
 * desktop behind the PiKVM; on a host with no rig it prints a clear skip and
 * exits 0, so it "just runs" the day a desktop-HDMI rig appears.
 *
 * The verdict math (grid, residual, landed-cluster, pass/fail) lives in
 * src/pikvm/desktop-e2e-metrics.ts and is unit-tested independently.
 *
 * Usage (on the desktop-HDMI node):
 *   PIKVM_HOST=https://pikvm.lan PIKVM_PASSWORD=… \
 *     npx tsx benches/desktop-e2e.ts [--cols 3] [--rows 3] [--threshold 20] \
 *       [--margin 0.15] [--click] [--settle 250]
 *
 * Exit code: 0 = PASS (or no-rig skip), 1 = FAIL / calibration error.
 * Output: data/desktop-e2e/run.json (+ per-trial rows).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { autoCalibrate } from '../src/pikvm/auto-calibrate.js';
import { decodeScreenshot, diffScreenshotsDecoded } from '../src/pikvm/cursor-detect.js';
import {
  buildTargetGrid,
  pickLandedCluster,
  summarizeResiduals,
  type Point,
  type TrialResult,
} from '../src/pikvm/desktop-e2e-metrics.js';

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const COLS = Number(flag('cols', '3'));
const ROWS = Number(flag('rows', '3'));
const THRESHOLD_PX = Number(flag('threshold', '20'));
const MARGIN = Number(flag('margin', '0.15'));
const SETTLE_MS = Number(flag('settle', '250'));
const DO_CLICK = hasFlag('click');
const OUT_DIR = './data/desktop-e2e';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  // --- Reachability guard: no rig → skip cleanly (exit 0) ---
  let client: PiKVMClient;
  let width: number;
  let height: number;
  try {
    const cfg = loadConfig();
    client = new PiKVMClient(cfg.pikvm);
    const res = await client.getResolution(true);
    width = res.width;
    height = res.height;
  } catch (err) {
    console.error(
      `desktop-e2e: no reachable PiKVM (${(err as Error).message}). ` +
        'Set PIKVM_HOST/PIKVM_PASSWORD to a DESKTOP behind a PiKVM and re-run. Skipping.',
    );
    return 0; // not a failure — there is simply no rig here
  }

  console.error(`desktop-e2e: ${width}×${height}, ${COLS}×${ROWS} grid, threshold ${THRESHOLD_PX}px`);

  // --- Calibrate the absolute path (cursor-agnostic motion diff) ---
  const cal = await autoCalibrate(client);
  if (!cal.success) {
    console.error(`desktop-e2e: auto_calibrate FAILED — ${cal.message}`);
    return 1;
  }
  console.error(
    `desktop-e2e: calibrated factorX=${cal.factorX.toFixed(4)} factorY=${cal.factorY.toFixed(4)}`,
  );

  const targets = buildTargetGrid(width, height, COLS, ROWS, MARGIN);

  // Baseline: park the cursor at the top-left inset corner so the first diff has
  // a clean "before". decode once; each trial diffs the previous frame → current.
  await client.mouseMove(Math.round(width * MARGIN * 0.5), Math.round(height * MARGIN * 0.5));
  await sleep(SETTLE_MS);
  let prev = await decodeScreenshot((await client.screenshot()).buffer);

  const results: TrialResult[] = [];
  for (const target of targets) {
    await client.mouseMove(target.x, target.y);
    await sleep(SETTLE_MS);
    const cur = await decodeScreenshot((await client.screenshot()).buffer);
    // What MOVED between the two frames = the cursor (+ any incidental churn).
    // pickLandedCluster takes the change nearest the requested target.
    let landed: Point | null = null;
    let residual: number | null = null;
    try {
      const clusters = diffScreenshotsDecoded(prev, cur);
      const hit = pickLandedCluster(clusters, target);
      if (hit) {
        landed = hit.landed;
        residual = hit.residualPx;
      }
    } catch (err) {
      // Resolution changed mid-run, etc. — record as a miss, keep going.
      console.error(`desktop-e2e: diff failed at ${target.x},${target.y}: ${(err as Error).message}`);
    }
    results.push({ target, landed, residualPx: residual });
    console.error(
      `  target (${target.x},${target.y}) → ` +
        (landed ? `landed (${Math.round(landed.x)},${Math.round(landed.y)}) residual ${residual!.toFixed(1)}px` : 'NOT LOCATED'),
    );
    prev = cur;
  }

  // --- Optional: click at centre + verify the screen changed ---
  let clickChanged: boolean | null = null;
  if (DO_CLICK) {
    const centre = { x: Math.round(width / 2), y: Math.round(height / 2) };
    await client.mouseMove(centre.x, centre.y);
    await sleep(SETTLE_MS);
    const before = await decodeScreenshot((await client.screenshot()).buffer);
    await client.mouseClick('left');
    await sleep(SETTLE_MS);
    const after = await decodeScreenshot((await client.screenshot()).buffer);
    // A click that does something changes pixels somewhere; report it (a static
    // desktop area may legitimately not change — informational, not pass/fail).
    clickChanged = diffScreenshotsDecoded(before, after).length > 0;
    console.error(`  click@centre: screen ${clickChanged ? 'CHANGED' : 'unchanged'}`);
  }

  const summary = summarizeResiduals(results, THRESHOLD_PX);
  console.error(
    `desktop-e2e: located ${summary.located}/${summary.n} ` +
      `(${(summary.locateRate * 100).toFixed(0)}%), residual p50=${summary.residualP50?.toFixed(1) ?? 'n/a'}px ` +
      `p90=${summary.residualP90?.toFixed(1) ?? 'n/a'}px → ${summary.passed ? 'PASS' : 'FAIL'}`,
  );

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, 'run.json'),
    JSON.stringify(
      { resolution: { width, height }, calibration: cal, summary, clickChanged, results },
      null,
      2,
    ),
  );
  console.error(`desktop-e2e: wrote ${path.join(OUT_DIR, 'run.json')}`);

  return summary.passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('desktop-e2e: unexpected error', err);
    process.exit(1);
  },
);
