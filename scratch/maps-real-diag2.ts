/**
 * Proper live-screen Maps test (fixing the prior flawed diagnostic). Per attempt:
 * RESET cursor (slamCenter → clear gap), V8-detect start, emit to Maps, ACTUALLY
 * CLICK, screenshot → did Maps open (frame != home)? Compares WITH-reset here to
 * the bench's NO-reset ~60%. If ~100%, the reset is the fix. Also runs a few
 * NO-reset attempts (cursor left at previous spot) to see the difference. Saves
 * PRE(cursor-at-start)+POST for misses. No getCursor (live screen).
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
const TARGET = { x: 1162, y: 570 };
const CURVE_Y = EMIT_CURVE_X.map(([m, p]) => [m, p * Y_SCALE] as const) as unknown as ReadonlyArray<readonly [number, number]>;
async function slamCenter(c: PiKVMClient) { for (let s = 0; s < 6; s++) await c.mouseMoveRelative(-127, -127); await sleep(200); await c.mouseMoveRelative(127, 127); await c.mouseMoveRelative(127, 127); await sleep(300); }
async function grayThumb(buf: Buffer, r: { x: number; y: number; w: number; h: number }) {
  return sharp(buf).extract({ left: Math.round(r.x), top: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) }).greyscale().resize(80, 110, { fit: 'fill' }).raw().toBuffer();
}
function changedFrac(a: Buffer, b: Buffer) { let c = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 25) c++; return c / a.length; }

async function main() {
  const client = new PiKVMClient(loadConfig().pikvm);
  const dir = 'scratch/maps-real-diag2'; await fs.mkdir(dir, { recursive: true });
  await ipadGoHome(client); await sleep(1800);
  const home = await client.screenshot();
  const reg0 = await detectIpadRegion(home.buffer);
  const region = { x: reg0.x + NATIVE_MARGIN, y: reg0.y + NATIVE_MARGIN, w: reg0.w - 2 * NATIVE_MARGIN, h: reg0.h - 2 * NATIVE_MARGIN };
  const homeThumb = await grayThumb(home.buffer, region);
  const v8 = async () => { const s = await client.screenshot({ quality: 80 }); const r = await findCursorByV8FullFrame(s.buffer, s.screenshotWidth, s.screenshotHeight); return { pos: r ? { x: Math.round(r.x), y: Math.round(r.y), p: r.presence } : null, buf: s.buffer }; };

  for (const mode of ['RESET', 'NO-RESET'] as const) {
    let hits = 0, n = 0;
    console.error(`\n=== ${mode} (emit to Maps + CLICK) ===`);
    console.error(`n\tV8_start\thit\tfrac`);
    for (let i = 0; i < 10; i++) {
      await client.mouseMoveRelative(40, 40); await sleep(80); await client.mouseMoveRelative(-40, -40); await sleep(80);
      await ipadGoHome(client); await sleep(1500);
      if (mode === 'RESET') await slamCenter(client);
      const pre = await v8();
      if (!pre.pos) { console.error(`${i}\tV8 null`); continue; }
      for (const e of planAxisEmits(TARGET.x - pre.pos.x, FULL_REPORT_PX, EMIT_CURVE_X)) { await client.mouseMoveRelative(e, 0); await sleep(110); }
      for (const e of planAxisEmits(TARGET.y - pre.pos.y, FULL_REPORT_PX * Y_SCALE, CURVE_Y)) { await client.mouseMoveRelative(0, e); await sleep(110); }
      await sleep(250);
      await client.mouseClick('left');
      await sleep(1400);
      const post = await client.screenshot({ quality: 80 });
      const frac = changedFrac(await grayThumb(post.buffer, region), homeThumb);
      const hit = frac > 0.15; if (hit) hits++; n++;
      console.error(`${i}\t(${pre.pos.x},${pre.pos.y})p${pre.pos.p.toFixed(2)}\t${hit ? 'HIT' : 'MISS'}\t${frac.toFixed(2)}`);
      if (!hit) { await fs.writeFile(`${dir}/${mode}-MISS-${i}-PRE_${pre.pos.x}_${pre.pos.y}.jpg`, pre.buf); await fs.writeFile(`${dir}/${mode}-MISS-${i}-POST.jpg`, post.buffer); }
    }
    console.error(`${mode} hit-rate: ${(hits / n * 100).toFixed(0)}% (${hits}/${n})`);
  }
  await ipadGoHome(client);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
