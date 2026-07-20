/**
 * HIGH-PRECISION test (user idea): the 4 small Maps-widget buttons (search/fuel/food/
 * bag, ~40px, spaced ~58px at y≈312) — a small-target regime the 80px app-icon bench
 * can't measure. Uses getCursor GROUND TRUTH: move to each button (curve-one-shot →
 * the dual-head cascade detector), read where the cursor ACTUALLY landed, and check it
 * landed nearest the INTENDED button (not the ±58px neighbour). Reports per-button
 * landing error (px, HDMI) + right-button-hit rate. This is the true precision metric.
 *
 * NOTE: buttons are inside the live-animated Maps widget (the original FP source), so
 * this also stresses the detector on that surface. Health-check + go home first.
 */
import { execSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';
import { startIpadAppServer, killOrphansOnPort, type IpadSession } from '../src/pikvm/ipad-app-ws.js';

const PORT = 8767, DEVICE = 'CF2B815D-7960-5B60-987B-FA2DC9A65353', BUNDLE = 'com.bb.iPadCollector';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const TRIALS = 5;
const BUTTONS = [
  { name: 'search', x: 1006, y: 312 }, { name: 'fuel', x: 1065, y: 312 },
  { name: 'food', x: 1123, y: 312 }, { name: 'bag', x: 1181, y: 312 },
];

function waitForSession(timeoutMs = 30000): Promise<{ sess: IpadSession; close: () => Promise<void> }> {
  let first: IpadSession | null = null;
  return new Promise((resolve, reject) => {
    const stop = startIpadAppServer({ port: PORT, onSession: async (sess) => { if (first) return; first = sess; const t0 = Date.now(); while (!sess.hello && Date.now() - t0 < 5000) await sleep(20); resolve({ sess, close: async () => { (await stop).close(); } }); } });
    setTimeout(() => { if (!first) { stop.then((s) => s.close()).catch(() => undefined); reject(new Error('no connect')); } }, timeoutMs);
  });
}

async function main() {
  killOrphansOnPort(PORT);
  const client = new PiKVMClient(loadConfig().pikvm);
  await ipadGoHome(client); await sleep(1500);
  const home = await client.screenshot();
  const reg = await detectIpadRegion(home.buffer);
  const tight = { x: reg.x + NATIVE_MARGIN, y: reg.y + NATIVE_MARGIN, w: reg.w - 2 * NATIVE_MARGIN, h: reg.h - 2 * NATIVE_MARGIN };
  try { execSync(`xcrun devicectl device process launch --terminate-existing --device ${DEVICE} ${BUNDLE}`, { stdio: 'pipe' }); } catch { /* */ }
  await sleep(3000);
  const { sess, close } = await waitForSession();
  if (!sess.hello) { await close(); throw new Error('no hello'); }
  const toHdmi = (x: number, y: number) => ({ x: tight.x + (x / sess.hello!.logicalW) * tight.w, y: tight.y + (y / sess.hello!.logicalH) * tight.h });

  const per: Record<string, { errs: number[]; hits: number; n: number }> = {};
  for (const b of BUTTONS) per[b.name] = { errs: [], hits: 0, n: 0 };
  for (let t = 0; t < TRIALS; t++) {
    for (const b of BUTTONS) {
      // reset the cursor somewhere else each trial so we're not already on target
      await client.mouseMoveRelative(-60, 60); await sleep(120);
      await moveToPixel(client, { x: b.x, y: b.y }, { strategy: 'curve-one-shot' }).catch(() => undefined);
      await sleep(400);
      let g = null; for (let i = 0; i < 6; i++) { const c = await sess.getTrackedCursor(); if (c) { g = toHdmi(c.x, c.y); break; } await sleep(150); }
      if (!g) { console.error(`  ${b.name} t${t}: no getCursor`); continue; }
      const err = Math.hypot(g.x - b.x, g.y - b.y);
      let nearest = BUTTONS[0], nd = Infinity;
      for (const o of BUTTONS) { const d = Math.hypot(g.x - o.x, g.y - o.y); if (d < nd) { nd = d; nearest = o; } }
      const hit = nearest.name === b.name;
      per[b.name].errs.push(err); per[b.name].n++; if (hit) per[b.name].hits++;
      console.error(`  ${b.name.padEnd(7)} t${t}: landed (${g.x.toFixed(0)},${g.y.toFixed(0)}) err=${err.toFixed(0)}px nearest=${nearest.name}${hit ? ' HIT' : ' <-- WRONG BUTTON'}`);
    }
  }
  await close().catch(() => undefined);
  await ipadGoHome(client);
  console.error(`\n=== MAPS-WIDGET 4-BUTTON PRECISION (getCursor truth, N=${TRIALS}/button) ===`);
  let allErr: number[] = [], hits = 0, n = 0;
  for (const b of BUTTONS) {
    const s = per[b.name]; allErr = allErr.concat(s.errs); hits += s.hits; n += s.n;
    console.error(`  ${b.name.padEnd(7)}: median err=${median(s.errs).toFixed(1)}px  right-button ${s.hits}/${s.n}`);
  }
  console.error(`  OVERALL: median landing err=${median(allErr).toFixed(1)}px  right-button ${hits}/${n} (${(hits / n * 100).toFixed(0)}%)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
