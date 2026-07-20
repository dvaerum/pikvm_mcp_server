/**
 * Interactive exploration harness — drive the iPad via the SHIPPED path (cascade
 * detector default + curve-one-shot mover) to flush out real-world edge cases:
 * open apps, go deep, hit small buttons, configure, and DRAG (pan Maps). Each
 * command saves scratch/explore-shot.jpg to LOOK at, then decide the next move.
 *
 * Usage (one command per invocation):
 *   tsx explore.ts shot
 *   tsx explore.ts home
 *   tsx explore.ts click X Y
 *   tsx explore.ts drag X1 Y1 X2 Y2
 *   tsx explore.ts type "some text"
 *   tsx explore.ts scroll DX DY
 *   tsx explore.ts key Escape
 */
import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { clickAtWithRetry } from '../src/pikvm/click-verify.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const client = new PiKVMClient(loadConfig().pikvm);
const [cmd, ...args] = process.argv.slice(2);
async function shot(tag = 'shot') {
  const s = await client.screenshot();
  await fs.writeFile('scratch/explore-shot.jpg', s.buffer);
  console.log(`[${tag}] scratch/explore-shot.jpg`);
}

switch (cmd) {
  case 'shot': await shot(); break;
  case 'home': await ipadGoHome(client); await sleep(1500); await shot('home'); break;
  case 'move': {
    const [x, y] = args.map(Number);
    await client.mouseMoveRelative(8, 8); await sleep(60); await client.mouseMoveRelative(-8, -8); await sleep(200);  // wake faded cursor
    const r = await moveToPixel(client, { x, y }, { strategy: 'curve-one-shot' });
    console.log(`move (${x},${y}) resid=${r.finalResidualPx?.toFixed(1)}px`);
    await sleep(600); await shot('move'); break;
  }
  case 'click': {
    const [x, y] = args.map(Number);
    await client.mouseMoveRelative(8, 8); await sleep(60); await client.mouseMoveRelative(-8, -8); await sleep(200);  // wake faded cursor (10-12s fade)
    const r = await clickAtWithRetry(client, { x, y }, { moveToOptions: { strategy: 'curve-one-shot' }, maxRetries: 3 });
    console.log(`click (${x},${y}) success=${r.success} resid=${r.finalMoveResult.finalResidualPx?.toFixed(1)}px outcome=${r.success ? 'OK' : (r.attemptHistory.at(-1)?.skippedClickReason ?? 'UNVERIFIED')}`);
    await sleep(1300); await shot('click'); break;
  }
  case 'drag': {
    const [x1, y1, x2, y2] = args.map(Number);
    await moveToPixel(client, { x: x1, y: y1 }, { strategy: 'curve-one-shot' });
    await sleep(250);
    await client.mouseClick('left', { state: true });   // button DOWN
    await sleep(140);
    const steps = 14, dx = (x2 - x1) / steps, dy = (y2 - y1) / steps;
    for (let i = 0; i < steps; i++) { await client.mouseMoveRelative(Math.round(dx), Math.round(dy)); await sleep(22); }
    await sleep(140);
    await client.mouseClick('left', { state: false });  // button UP
    console.log(`drag (${x1},${y1})->(${x2},${y2})`);
    await sleep(1000); await shot('drag'); break;
  }
  case 'type': { await client.type(args.join(' ')); await sleep(700); await shot('type'); break; }
  case 'scroll': { const [dx, dy] = args.map(Number); await client.mouseScroll(dx, dy); await sleep(900); await shot('scroll'); break; }
  case 'key': { await client.type(''); await sleep(50); /* key via type fallback */ console.log('use pikvm key primitive if needed'); await shot('key'); break; }
  default: console.log('usage: shot | home | click X Y | drag X1 Y1 X2 Y2 | type "text" | scroll DX DY');
}
process.exit(0);
