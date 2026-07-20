/**
 * Smoke: does locateCursor (probe + motion-diff) reliably find the cursor on the
 * REAL home screen where V8 false-positives on widgets? Places the cursor at a
 * few spots, then compares locateCursor vs V8 vs the visible cursor (screenshot).
 */
import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { locateCursor } from '../src/pikvm/cursor-detect.js';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function slamCenter(c: PiKVMClient) { for (let s = 0; s < 6; s++) await c.mouseMoveRelative(-127, -127); await sleep(200); await c.mouseMoveRelative(127, 127); await c.mouseMoveRelative(127, 127); await sleep(300); }

async function main() {
  const client = new PiKVMClient(loadConfig().pikvm);
  await ipadGoHome(client); await sleep(1500);
  const dir = 'scratch/smoke-locate'; await fs.mkdir(dir, { recursive: true });
  const v8 = async () => { const s = await client.screenshot({ quality: 80 }); const r = await findCursorByV8FullFrame(s.buffer, s.screenshotWidth, s.screenshotHeight); return r ? { x: Math.round(r.x), y: Math.round(r.y), presence: r.presence } : null; };

  // place cursor at a few spots (slam center then curve-ish nudge to region)
  const spots: Array<[string, number, number]> = [
    ['center', 0, 0], ['near-Maps-widget', 120, -180], ['top-right', 180, -260], ['bottom', 30, 200], ['left', -180, -60],
  ];
  for (const [name, dx, dy] of spots) {
    await slamCenter(client);
    // nudge toward the spot (coarse; just to vary position)
    if (dx || dy) { await client.mouseMoveRelative(Math.max(-127, Math.min(127, dx)), Math.max(-127, Math.min(127, dy))); await sleep(300); }
    const v8Before = await v8();
    let loc: Awaited<ReturnType<typeof locateCursor>> = null;
    try { loc = await locateCursor(client); } catch (e) { /* */ }
    const shot = await client.screenshot({ quality: 80 });
    await fs.writeFile(`${dir}/${name}.jpg`, shot.buffer);
    const v8After = await v8();
    console.error(`${name}: V8before=${v8Before ? `(${v8Before.x},${v8Before.y})p${v8Before.presence.toFixed(2)}` : 'null'}  locateCursor=${loc ? `(${loc.position.x},${loc.position.y}) clusters=${loc.clusterCount}` : 'NULL'}  V8after=${v8After ? `(${v8After.x},${v8After.y})` : 'null'}`);
  }
  console.error(`\nFrames in ${dir}/ (cursor position AFTER locateCursor's probe). Compare locateCursor vs V8after to the visible cursor.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
