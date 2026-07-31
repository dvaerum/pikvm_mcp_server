/** GATE for task #38 — (a) 5.9px click-bias correction + (b) maxResidualPx 25->15.
 *
 * MUST go through the REAL click path: the bias correction lives in click-verify,
 * so a harness that calls moveToPixel + mouseClick directly (like tap-bias.ts)
 * would BYPASS it and show no change. So this drives `pikvm_mouse_click_at` via a
 * spawned server, while simultaneously holding an iPadCollector session to
 * capture the ACTUAL tap via onTapEvent.
 *
 * The number that matters is MISS = actual tap - requested target. It should drop
 * from ~6.1px to ~1.1px in Y. A SIGN ERROR would roughly DOUBLE it (~11.8px) —
 * that is the failure this gate exists to catch.
 * Also counts skips, to confirm the tightened 15px gate doesn't manufacture them.
 *
 * usage: npx tsx scratch/gate-38.ts <label> [reps]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { promises as fs } from 'fs';
import { execSync } from 'child_process';
import { connectIpadSession, setupGreyScene, sleep } from '../benches/lib/groundtruth.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { loadConfig } from '../src/config.js';
import type { TapEvent } from '../src/pikvm/ipad-app-ws.js';

const TARGETS = [
  { name: 'k1-topleft', cls: 'small', x: 857, y: 490 },
  { name: 'k3-topright', cls: 'small', x: 1061, y: 490 },
  { name: 'k5-centre', cls: 'small', x: 959, y: 561 },
  { name: 'k0-bottom', cls: 'small', x: 959, y: 703 },
  { name: 'card-TL', cls: 'large', x: 797, y: 385 },
  { name: 'card-BR', cls: 'large', x: 1121, y: 810 },
];
const LABEL = process.argv[2] ?? 'unlabelled';
const REPS = Number(process.argv[3] ?? 5);
const OUT = `/private/tmp/claude-501/-Users-georg-pikvm-mcp-server/69f79ce5-6389-4285-9eb8-047c6e09ea53/scratchpad/gate38-${LABEL}.jsonl`;
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

async function main() {
  const sess = await connectIpadSession();
  const client = new PiKVMClient(loadConfig().pikvm);
  const geom = await setupGreyScene(sess, client);
  await fs.writeFile(OUT, '');
  let lastTap: TapEvent | null = null;
  sess.onTapEvent = (ev) => { lastTap = ev; };

  const transport = new StdioClientTransport({ command: './node_modules/.bin/tsx', args: ['src/index.ts', '--target', 'ipad'], env: { ...process.env } as Record<string, string> });
  const mcp = new Client({ name: 'gate38', version: '0' }, { capabilities: {} });
  await mcp.connect(transport);
  const txt = (r: any) => ((r.content.find((x: any) => x.type === 'text')?.text ?? '') as string).replace(/\s+/g, ' ');
  const SHA = execSync('git rev-parse --short HEAD').toString().trim();
  console.error(`GATE-38 [${LABEL}] build ${SHA} — real click_at + onTapEvent ground truth\n`);

  const missY: number[] = [], missAll: number[] = []; let skips = 0, taps = 0;
  const perCls: Record<string, number[]> = { small: [], large: [] };
  for (let r = 1; r <= REPS; r++) {
    for (const t of TARGETS) {
      lastTap = null;
      const out = txt(await mcp.callTool({ name: 'pikvm_mouse_click_at', arguments: { x: t.x, y: t.y } }));
      const skipped = /NOT performed/i.test(out);
      if (skipped) { skips++; console.error(`  r${r} ${t.name.padEnd(12)} SKIPPED`); await fs.appendFile(OUT, JSON.stringify({ label: LABEL, rep: r, target: t.name, skipped: true }) + '\n'); continue; }
      for (let w = 0; w < 30 && !lastTap; w++) await sleep(100);
      if (!lastTap) { console.error(`  r${r} ${t.name.padEnd(12)} NO TAP EVENT`); continue; }
      const tap = geom.ipadToHdmi((lastTap as TapEvent).x, (lastTap as TapEvent).y);
      const mx = tap.x - t.x, my = tap.y - t.y, mag = Math.hypot(mx, my);
      missY.push(my); missAll.push(mag); perCls[t.cls].push(mag); taps++;
      await fs.appendFile(OUT, JSON.stringify({ label: LABEL, rep: r, target: t.name, cls: t.cls, tx: t.x, ty: t.y, tapx: Number(tap.x.toFixed(1)), tapy: Number(tap.y.toFixed(1)), missX: Number(mx.toFixed(1)), missY: Number(my.toFixed(1)), miss: Number(mag.toFixed(1)) }) + '\n');
      console.error(`  r${r} ${t.name.padEnd(12)} miss (${mx.toFixed(1).padStart(6)},${my.toFixed(1).padStart(6)}) |${mag.toFixed(1)}px|`);
      await sleep(300);
    }
  }
  console.error(`\n===== GATE-38 [${LABEL}] ${SHA} =====`);
  console.error(`  taps ${taps}, skipped ${skips}`);
  console.error(`  miss |Y| median ${med(missY.map(Math.abs)).toFixed(1)}px   signed-Y median ${med(missY).toFixed(1)}px`);
  console.error(`  miss magnitude median ${med(missAll).toFixed(1)}px  max ${Math.max(...missAll).toFixed(1)}px`);
  for (const c of ['small', 'large']) if (perCls[c].length) console.error(`    ${c.padEnd(6)} median ${med(perCls[c]).toFixed(1)}px max ${Math.max(...perCls[c]).toFixed(1)}px`);
  console.error(`  raw: ${OUT}`);
  await mcp.close(); process.exit(0);
}
main().catch((e) => { console.error('FATAL: ' + e); process.exit(2); });
