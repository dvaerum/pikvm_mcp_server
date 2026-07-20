/**
 * VERIFY whether the residual miss tail is DETECTION (V8 start-FP) or EMIT.
 * Interleaved 8-target bench (reproduces the misses), SINGLE-SHOT (no correction/
 * retry, exposes the raw first-shot), full instrumentation. On each MISS: log
 * V8_start + V8_final and save PRE (cursor at start) + POST frames. PRE-frame
 * cursor vs logged V8_start is the decisive test:
 *   PRE-cursor ≈ V8_start  → V8 correct → miss is EMIT (cursor didn't reach target)
 *   PRE-cursor ≠ V8_start  → V8 false-positive → DETECTION
 */
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
import { planAxisEmits, EMIT_CURVE_X, FULL_REPORT_PX, Y_SCALE } from '../src/pikvm/curve-mover.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TARGETS: Record<string, { x: number; y: number }> = {
  FaceTime: { x: 1027, y: 435 }, Files: { x: 1162, y: 435 },
  Reminders: { x: 1027, y: 570 }, Maps: { x: 1162, y: 570 },
  AppStore: { x: 1027, y: 702 }, Games: { x: 1162, y: 702 },
  Books: { x: 757, y: 837 }, Settings: { x: 1027, y: 837 },
};
const CURVE_Y = EMIT_CURVE_X.map(([m, p]) => [m, p * Y_SCALE] as const) as unknown as ReadonlyArray<readonly [number, number]>;
async function grayThumb(buf: Buffer, r: { x: number; y: number; w: number; h: number }) {
  return sharp(buf).extract({ left: Math.round(r.x), top: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) }).greyscale().resize(80, 110, { fit: 'fill' }).raw().toBuffer();
}
function changedFrac(a: Buffer, b: Buffer) { let c = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 25) c++; return c / a.length; }

async function main() {
  const client = new PiKVMClient(loadConfig().pikvm);
  const dir = 'scratch/instrumented-bench'; await fs.mkdir(dir, { recursive: true });
  await ipadGoHome(client); await sleep(1800);
  const home = await client.screenshot();
  const reg0 = await detectIpadRegion(home.buffer);
  const region = { x: reg0.x + NATIVE_MARGIN, y: reg0.y + NATIVE_MARGIN, w: reg0.w - 2 * NATIVE_MARGIN, h: reg0.h - 2 * NATIVE_MARGIN };
  const homeThumb = await grayThumb(home.buffer, region);
  const v8 = async () => { const s = await client.screenshot({ quality: 80 }); const r = await findCursorByV8FullFrame(s.buffer, s.screenshotWidth, s.screenshotHeight); return { pos: r ? { x: Math.round(r.x), y: Math.round(r.y), p: r.presence } : null, buf: s.buffer }; };

  let hits = 0, n = 0;
  const misses: string[] = [];
  for (let t = 1; t <= 10; t++) {
    for (const [name, target] of Object.entries(TARGETS)) {
      await client.mouseMoveRelative(40, 40); await sleep(80); await client.mouseMoveRelative(-40, -40); await sleep(80);
      await ipadGoHome(client); await sleep(1500);
      const pre = await v8();
      if (!pre.pos) { console.error(`t${t} ${name}: V8 null`); continue; }
      for (const e of planAxisEmits(target.x - pre.pos.x, FULL_REPORT_PX, EMIT_CURVE_X)) { await client.mouseMoveRelative(e, 0); await sleep(110); }
      for (const e of planAxisEmits(target.y - pre.pos.y, FULL_REPORT_PX * Y_SCALE, CURVE_Y)) { await client.mouseMoveRelative(0, e); await sleep(110); }
      await sleep(250);
      const fin = await v8(); // V8 after the shot (before click)
      await client.mouseClick('left'); await sleep(1300);
      const post = await client.screenshot({ quality: 80 });
      const hit = changedFrac(await grayThumb(post.buffer, region), homeThumb) > 0.15;
      if (hit) hits++; n++;
      if (!hit) {
        const tag = `t${t}-${name}-V8start_${pre.pos.x}_${pre.pos.y}-V8fin_${fin.pos ? `${fin.pos.x}_${fin.pos.y}` : 'null'}`;
        await fs.writeFile(`${dir}/MISS-${tag}-PRE.jpg`, pre.buf);
        await fs.writeFile(`${dir}/MISS-${tag}-POST.jpg`, post.buffer);
        misses.push(`${name}: V8_start=(${pre.pos.x},${pre.pos.y})p${pre.pos.p.toFixed(2)} → target=(${target.x},${target.y}) → V8_final=${fin.pos ? `(${fin.pos.x},${fin.pos.y})` : 'null'}  [PRE frame shows REAL cursor at start]`);
        console.error(`  MISS ${tag}`);
      }
    }
    console.error(`after trial ${t}: ${(hits / n * 100).toFixed(0)}% (${hits}/${n})`);
  }
  await ipadGoHome(client);
  console.error(`\nSINGLE-SHOT hit-rate ${(hits / n * 100).toFixed(0)}% (${hits}/${n})`);
  console.error(`MISSES (${misses.length}) — check PRE frames: does the real cursor match V8_start?`);
  for (const m of misses) console.error(`  ${m}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
