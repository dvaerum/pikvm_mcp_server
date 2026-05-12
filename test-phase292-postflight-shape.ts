/**
 * Phase 292: validate post-flight cursor-shape-detect hypothesis.
 *
 * Phase 291 showed motion-diff reports cursor positions that are
 * 100-330 px from where the cursor visually ends up. Hypothesis:
 * adding a post-flight shape-detect (after settle delay) on the
 * fully-settled frame will recover the true cursor position, even
 * when motion-diff during the move was confused.
 *
 * Test: for 10 trials, moveToPixel to (757, 832); after return,
 * wait 800 ms; take fresh screenshot; run shape-detect with a
 * GENEROUS locality gate (radius 400 from belief.position). Save
 * the settled frame + log shape-detect's pick.
 *
 * Acceptance: shape-detect pick is within 30 px of visually-true
 * cursor position on ≥7/10 trials. If yes → implement as a
 * post-flight verification step in moveToPixel.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { findCursorByShape } from './src/pikvm/cursor-shape-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = `./data/phase292-postflight/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 292 post-flight shape-detect at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGET = { x: 757, y: 832 };
const N = 10;

interface Row { trial: number; algoReported: string; algoResidual: string; settlePick: string; settleResidual: string; settleScore: string }
const rows: Row[] = [];

for (let i = 1; i <= N; i++) {
  console.error(`\n--- Trial ${i}/${N} ---`);

  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1200);

  let r: Awaited<ReturnType<typeof moveToPixel>> | null = null;
  try {
    r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
  } catch (e) {
    console.error(`  moveToPixel threw: ${(e as Error).message.slice(0, 100)}`);
  }

  // Wait for cursor inertia / snap to settle
  await sleep(800);

  // Settled-frame shape-detect with GENEROUS locality from belief
  const shot = await client.screenshotKeepingCursorAlive();
  await fs.writeFile(`${ROOT}/t${i.toString().padStart(2, '0')}-settled.jpg`, shot.buffer);

  const decoded = await sharp(shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const beliefPos = client.belief.position;
  const settled = findCursorByShape(decoded.data, decoded.info.width, decoded.info.height, {
    expectedNear: { x: beliefPos.x, y: beliefPos.y },
    expectedNearRadius: 400, // very generous — catches cursor anywhere reasonably close
  });

  const algoDetected = r?.finalDetectedPosition ?? null;
  const algoResidual = r?.finalResidualPx ?? null;
  const settledResidual = settled
    ? Math.hypot(settled.centroidX - TARGET.x, settled.centroidY - TARGET.y)
    : null;

  console.error(
    `  algo: ${algoDetected ? `(${algoDetected.x},${algoDetected.y}) r=${algoResidual?.toFixed(0)}px` : 'null'}` +
    `  belief: (${beliefPos.x.toFixed(0)},${beliefPos.y.toFixed(0)})`,
  );
  console.error(
    `  shape-detect on settled frame, r=400 around belief: ${
      settled
        ? `(${Math.round(settled.centroidX)},${Math.round(settled.centroidY)}) r=${settledResidual?.toFixed(0)}px score=${settled.shapeScore.toFixed(3)}`
        : 'null'
    }`,
  );

  rows.push({
    trial: i,
    algoReported: algoDetected ? `(${algoDetected.x},${algoDetected.y})` : 'null',
    algoResidual: algoResidual !== null ? `${algoResidual.toFixed(0)}px` : 'n/a',
    settlePick: settled ? `(${Math.round(settled.centroidX)},${Math.round(settled.centroidY)})` : 'null',
    settleResidual: settledResidual !== null ? `${settledResidual.toFixed(0)}px` : 'n/a',
    settleScore: settled ? settled.shapeScore.toFixed(3) : 'n/a',
  });
}

console.error(`\n=== SUMMARY ===`);
console.error('trial | algo reported    | algo r  | settled pick    | settled r | score');
console.error('------|------------------|---------|-----------------|-----------|------');
for (const r of rows) {
  console.error(`  ${String(r.trial).padStart(3)} | ${r.algoReported.padEnd(17)}| ${r.algoResidual.padEnd(8)}| ${r.settlePick.padEnd(16)}| ${r.settleResidual.padEnd(10)}| ${r.settleScore}`);
}

await fs.writeFile(`${ROOT}/summary.json`, JSON.stringify(rows, null, 2));
console.error(`\nSee ${ROOT}/t*-settled.jpg and visually verify shape-detect picks.`);
process.exit(0);
