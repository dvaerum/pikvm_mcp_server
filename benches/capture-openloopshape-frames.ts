/**
 * Capture REAL grey-0.55 frames with the cursor parked at each standardTarget,
 * for the offline worker's openLoopShape detector diagnosis (@nixos-developer-system).
 * Emphasis on upper-right (live locate 0%). No live detection loop — just capture.
 *
 * DATA CONTRACT (must match benches/analyze-openloopshape-real.ts, commit 0dc7c1b):
 *   Dir:      data/openloopshape-real/
 *   Manifest: data/openloopshape-real/manifest.jsonl — one JSON object per line:
 *     { "file": "frame-upper-right-01.jpg", "target": "upper-right",
 *       "gt_x": 1112, "gt_y": 308, "hdmi_w": 1920, "hdmi_h": 1080 }
 *   gt_x/gt_y = iPadCollector getCursor mapped to HDMI pixels; the JPEG is the full
 *   HDMI frame. Extra diagnostic fields (region/tight/NATIVE_MARGIN) are appended for
 *   the crop-clip hypothesis; analyze-openloopshape-real ignores unknown fields.
 *
 * Usage: PIKVM_PROXY=http://127.0.0.1:8888 npx tsx benches/capture-openloopshape-frames.ts [--per-upper N] [--per-other N]
 */

import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';
import {
  connectIpadSession, setupGreyScene, standardTargets, slamToCorner, readCursorHdmi, sleep,
} from './lib/groundtruth.js';

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
const PER_UPPER = arg('--per-upper', 6);
const PER_OTHER = arg('--per-other', 2);
const OUT_DIR = './data/openloopshape-real';

async function main() {
  console.error(`[ols-capture] per-upper=${PER_UPPER} per-other=${PER_OTHER} -> ${OUT_DIR}`);
  const sess = await connectIpadSession();
  const client = new PiKVMClient(loadConfig().pikvm);
  const geom = await setupGreyScene(sess, client, 0.55); // grey 0.55 as requested
  console.error(`[ols-capture] tight region: ${JSON.stringify(geom.tight)}`);

  // Raw detected region (pre-NATIVE_MARGIN) for the crop-clip hypothesis diagnostics.
  const rawShot = await client.screenshot();
  const region = await detectIpadRegion(rawShot.buffer);
  console.error(`[ols-capture] raw region: ${JSON.stringify(region)}  NATIVE_MARGIN=${NATIVE_MARGIN}`);

  const profile = await loadProfile('./data/ballistics.json').catch(() => null);
  const targets = Object.fromEntries(standardTargets(geom.tight).map((t) => [t.name, t]));

  // Emphasis on upper-right (the 0%-locate case); a few controls of each other target.
  const plan: string[] = [
    ...Array(PER_UPPER).fill('upper-right'),
    ...Array(PER_OTHER).fill('mid-center'),
    ...Array(PER_OTHER).fill('lower-left'),
    ...Array(PER_OTHER).fill('lower-right'),
  ];

  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  const manifest: unknown[] = [];
  const perTargetSeq: Record<string, number> = {};

  console.error('');
  console.error('file                          getCursor->HDMI   target(hdmi)   miss  tracked');
  console.error('-'.repeat(82));

  for (const name of plan) {
    const target = targets[name];
    await slamToCorner(client);
    try {
      await moveToPixel(client, target, { profile: profile ?? undefined, strategy: 'curve-one-shot', forbidSlamFallback: true });
    } catch (e) {
      console.error(`  ${name}: move threw ${(e as Error).message}`); continue;
    }
    await sleep(300);

    const gt = await readCursorHdmi(sess, geom);
    if (!gt) { console.error(`  ${name}: getCursor failed; skipping`); continue; }
    const tracked = gt.cursorLogical.x !== 0 || gt.cursorLogical.y !== 0; // (0,0) = tracker lost the cursor

    const raw = await client.screenshotKeepingCursorAlive();
    const seq = (perTargetSeq[name] = (perTargetSeq[name] ?? 0) + 1);
    const file = `frame-${name}-${String(seq).padStart(2, '0')}.jpg`;
    await fs.writeFile(`${OUT_DIR}/${file}`, raw.buffer);

    const gtHdmi = { x: Math.round(gt.ipadHdmi.x), y: Math.round(gt.ipadHdmi.y) };
    const miss = Math.round(Math.hypot(gtHdmi.x - target.x, gtHdmi.y - target.y));
    manifest.push({
      // --- required contract (analyze-openloopshape-real.ts) ---
      file, target: name, gt_x: gtHdmi.x, gt_y: gtHdmi.y,
      hdmi_w: raw.screenshotWidth, hdmi_h: raw.screenshotHeight,
      // --- extra diagnostics (ignored by analyze; for the crop-clip hypothesis) ---
      getCursorLogical: gt.cursorLogical, targetHdmi: { x: target.x, y: target.y },
      region, nativeMargin: NATIVE_MARGIN, tight: geom.tight,
      scaleHdmiPerLogical: geom.scaleHdmiPerLogical,
      logicalW: sess.hello!.logicalW, logicalH: sess.hello!.logicalH,
    });
    console.error(
      `${file.padEnd(28)}  (${String(gtHdmi.x).padStart(4)},${String(gtHdmi.y).padStart(4)})  ` +
      `(${String(target.x).padStart(4)},${String(target.y).padStart(4)})   ${String(miss).padStart(4)}px  ${tracked ? 'yes' : 'NO(0,0)'}`,
    );
  }

  await fs.writeFile(`${OUT_DIR}/manifest.jsonl`, manifest.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.error(`\n[ols-capture] wrote ${manifest.length} frames + manifest.jsonl to ${OUT_DIR}`);
  if (manifest.some((r) => (r as { gt_x: number; gt_y: number }).gt_x === (geom.tight.x) && (r as { gt_y: number }).gt_y === geom.tight.y)) {
    console.error('[ols-capture] WARNING: some GT maps to the tight top-left corner — cursor likely untracked (HID/fade). Inspect frames before trusting.');
  }
  process.exit(0);
}

main().catch((e) => { console.error(`FATAL: ${e}`); process.exit(2); });
