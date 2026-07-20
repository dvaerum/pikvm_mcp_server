/**
 * Does a slamCenter reset before detection fix the persistent Settings V8
 * start-FP? Settings clicks, RESET mode, N=15, real clicks, hit-rate + re-lock
 * safety check (verify each round the screen is still home, not locked). The
 * reset overrides the start position → cursor in a clear gap where V8 detects
 * reliably (maps-real-diag2 proved this for Maps). No getCursor (live screen).
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
const SETTINGS = { x: 1027, y: 837 }, BOOKS = { x: 757, y: 837 };
const CURVE_Y = EMIT_CURVE_X.map(([m, p]) => [m, p * Y_SCALE] as const) as unknown as ReadonlyArray<readonly [number, number]>;
async function slamCenter(c: PiKVMClient) { for (let s = 0; s < 6; s++) await c.mouseMoveRelative(-127, -127); await sleep(200); await c.mouseMoveRelative(127, 127); await c.mouseMoveRelative(127, 127); await sleep(300); }
async function grayThumb(buf: Buffer, r: { x: number; y: number; w: number; h: number }) {
  return sharp(buf).extract({ left: Math.round(r.x), top: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) }).greyscale().resize(80, 110, { fit: 'fill' }).raw().toBuffer();
}
function changedFrac(a: Buffer, b: Buffer) { let c = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 25) c++; return c / a.length; }

async function main() {
  const client = new PiKVMClient(loadConfig().pikvm);
  const dir = 'scratch/settings-reset-test'; await fs.mkdir(dir, { recursive: true });
  await ipadGoHome(client); await sleep(1800);
  const home = await client.screenshot();
  const reg0 = await detectIpadRegion(home.buffer);
  const region = { x: reg0.x + NATIVE_MARGIN, y: reg0.y + NATIVE_MARGIN, w: reg0.w - 2 * NATIVE_MARGIN, h: reg0.h - 2 * NATIVE_MARGIN };
  const homeThumb = await grayThumb(home.buffer, region);
  const v8 = async () => { const s = await client.screenshot({ quality: 80 }); const r = await findCursorByV8FullFrame(s.buffer, s.screenshotWidth, s.screenshotHeight); return r ? { x: Math.round(r.x), y: Math.round(r.y) } : null; };
  const oneShot = async (tgt: { x: number; y: number }, start: { x: number; y: number }) => {
    for (const e of planAxisEmits(tgt.x - start.x, FULL_REPORT_PX, EMIT_CURVE_X)) { await client.mouseMoveRelative(e, 0); await sleep(110); }
    for (const e of planAxisEmits(tgt.y - start.y, FULL_REPORT_PX * Y_SCALE, CURVE_Y)) { await client.mouseMoveRelative(0, e); await sleep(110); }
    await sleep(250);
  };

  for (const mode of ['NO-RESET', 'RESET'] as const) {
    let hits = 0, n = 0, relocks = 0;
    console.error(`\n=== ${mode} Settings (come from Books each round) ===`);
    for (let i = 0; i < 12; i++) {
      // position cursor at Books (reproduce the bench's pre-Settings state)
      await ipadGoHome(client); await sleep(1300);
      const b0 = await v8(); if (b0) { await oneShot(BOOKS, b0); await client.mouseClick('left'); await sleep(1000); }
      await ipadGoHome(client); await sleep(1300);
      // re-lock safety check: is the screen still home?
      const chk = await client.screenshot({ quality: 80 });
      if (changedFrac(await grayThumb(chk.buffer, region), homeThumb) > 0.15) { relocks++; console.error(`  ${i}: SCREEN NOT HOME (possible re-lock/app) — skipping`); await ipadGoHome(client); await sleep(1500); continue; }
      // now the Settings click, with/without reset
      if (mode === 'RESET') await slamCenter(client);
      const s0 = await v8(); if (!s0) { console.error(`${i}\tnull`); continue; }
      await oneShot(SETTINGS, s0);
      await client.mouseClick('left'); await sleep(1400);
      const post = await client.screenshot({ quality: 80 });
      const hit = changedFrac(await grayThumb(post.buffer, region), homeThumb) > 0.15;
      if (hit) hits++; n++;
      if (!hit) await fs.writeFile(`${dir}/${mode}-MISS-${i}-v8_${s0.x}_${s0.y}.jpg`, post.buffer);
      console.error(`${i}\tV8_start=(${s0.x},${s0.y})\t${hit ? 'HIT' : 'MISS'}`);
    }
    console.error(`${mode}: hit-rate ${(hits / n * 100).toFixed(0)}% (${hits}/${n})  [not-home events: ${relocks}]`);
  }
  await ipadGoHome(client);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
