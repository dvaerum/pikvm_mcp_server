/**
 * Faithful reproduction of the bench Maps miss: cursor comes FROM the previous
 * target (Reminders) → Maps, real clicks, FULL instrumentation of the one-shot
 * (V8-start, emit, V8-after-first-shot, correction fired?, V8-final). Same start
 * each round, so if it still misses intermittently the cause is live screen state.
 * Saves PRE+POST for misses. No getCursor (live screen).
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
const MAPS = { x: 1162, y: 570 }, REMINDERS = { x: 1027, y: 570 };
const CURVE_Y = EMIT_CURVE_X.map(([m, p]) => [m, p * Y_SCALE] as const) as unknown as ReadonlyArray<readonly [number, number]>;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
async function grayThumb(buf: Buffer, r: { x: number; y: number; w: number; h: number }) {
  return sharp(buf).extract({ left: Math.round(r.x), top: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) }).greyscale().resize(80, 110, { fit: 'fill' }).raw().toBuffer();
}
function changedFrac(a: Buffer, b: Buffer) { let c = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 25) c++; return c / a.length; }

async function main() {
  const client = new PiKVMClient(loadConfig().pikvm);
  const dir = 'scratch/maps-faithful'; await fs.mkdir(dir, { recursive: true });
  await ipadGoHome(client); await sleep(1800);
  const home = await client.screenshot();
  const reg0 = await detectIpadRegion(home.buffer);
  const region = { x: reg0.x + NATIVE_MARGIN, y: reg0.y + NATIVE_MARGIN, w: reg0.w - 2 * NATIVE_MARGIN, h: reg0.h - 2 * NATIVE_MARGIN };
  const homeThumb = await grayThumb(home.buffer, region);
  const v8 = async () => { const s = await client.screenshot({ quality: 80 }); const r = await findCursorByV8FullFrame(s.buffer, s.screenshotWidth, s.screenshotHeight); return { pos: r ? { x: Math.round(r.x), y: Math.round(r.y), p: r.presence } : null, buf: s.buffer }; };
  const oneShot = async (tgt: { x: number; y: number }, start: { x: number; y: number }) => {
    for (const e of planAxisEmits(tgt.x - start.x, FULL_REPORT_PX, EMIT_CURVE_X)) { await client.mouseMoveRelative(e, 0); await sleep(110); }
    for (const e of planAxisEmits(tgt.y - start.y, FULL_REPORT_PX * Y_SCALE, CURVE_Y)) { await client.mouseMoveRelative(0, e); await sleep(110); }
    await sleep(250);
  };

  let hits = 0, n = 0;
  console.error(`\nFaithful Reminders→Maps (full instrumented one-shot + correction):`);
  console.error(`n\tV8_start\tV8_mid(afterShot)\tmidRes\tcorrected?\tV8_final\thit`);
  for (let i = 0; i < 15; i++) {
    await ipadGoHome(client); await sleep(1400);
    // 1) put cursor on Reminders (previous target) via a one-shot from V8-start
    const s0 = await v8(); if (!s0.pos) { console.error(`${i}\tnull`); continue; }
    await oneShot(REMINDERS, s0.pos);
    await client.mouseClick('left'); await sleep(1200); // opens Reminders
    await ipadGoHome(client); await sleep(1400);        // back home, cursor at ~Reminders
    // 2) now the instrumented Maps one-shot with correction
    const pre = await v8(); if (!pre.pos) { console.error(`${i}\tnull2`); continue; }
    await oneShot(MAPS, pre.pos);
    const mid = await v8(); // after first shot
    const midRes = mid.pos ? dist(mid.pos, MAPS) : NaN;
    let corrected = 'no';
    if (mid.pos && midRes > 30) { corrected = `yes(${midRes.toFixed(0)})`; await oneShot(MAPS, mid.pos); }
    const fin = await v8();
    await client.mouseClick('left'); await sleep(1400);
    const post = await client.screenshot({ quality: 80 });
    const frac = changedFrac(await grayThumb(post.buffer, region), homeThumb);
    const hit = frac > 0.15; if (hit) hits++; n++;
    console.error(`${i}\t(${pre.pos.x},${pre.pos.y})\t${mid.pos ? `(${mid.pos.x},${mid.pos.y})` : 'null'}\t${midRes.toFixed(0)}\t${corrected}\t${fin.pos ? `(${fin.pos.x},${fin.pos.y})` : 'null'}\t${hit ? 'HIT' : 'MISS'}`);
    if (!hit) { await fs.writeFile(`${dir}/MISS-${i}-PRE_${pre.pos.x}_${pre.pos.y}.jpg`, pre.buf); await fs.writeFile(`${dir}/MISS-${i}-POST.jpg`, post.buffer); }
  }
  await ipadGoHome(client);
  console.error(`\nhit-rate ${(hits / n * 100).toFixed(0)}% (${hits}/${n})`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
