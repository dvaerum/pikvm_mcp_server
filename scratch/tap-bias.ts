/** Task #38 STEP 1 — the actual-tap triple, on the real rig.
 *
 * `maxResidualPx` gates DETECTED-vs-TARGET. But the click lands at the pointer
 * TIP, so if detected and tip differ systematically, tightening the gate rejects
 * clicks WITHOUT moving any click closer to the target. Before picking a
 * tolerance we must know where taps ACTUALLY land.
 *
 * Per trial: click a target, and record the triple
 *     target  ->  detected (what the gate sees)  ->  ACTUAL TAP (onTapEvent)
 * onTapEvent (ipad-app-ws.ts:142) reports the tap in iPad LOGICAL coords; we map
 * to HDMI via the calibrated geometry so all three are comparable.
 *
 * Outputs:
 *   bias = actualTap - detected   (the tip-vs-detected offset; the thing that
 *                                  decides correct-at-source vs tighten-tolerance)
 *   miss = actualTap - target     (what the user actually experiences)
 * Reported per target CLASS (small PIN keys vs large buttons) and per position,
 * so a CONSTANT bias (correctable) is distinguishable from a POSITION-DEPENDENT
 * one (tolerance is then the right lever).
 *
 * usage: npx tsx scratch/tap-bias.ts [repsPerTarget]
 */
import { promises as fs } from 'fs';
import { connectIpadSession, setupGreyScene, readCursorHdmi, sleep } from '../benches/lib/groundtruth.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { loadConfig } from '../src/config.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import type { TapEvent } from '../src/pikvm/ipad-app-ws.js';

type Target = { name: string; cls: 'small' | 'large'; x: number; y: number };
// Positions spread across the region so a position-dependent bias is visible.
// Sizes mirror the real WB UI: PIN keys ~88x58px, machine cards ~300x400px.
const TARGETS: Target[] = [
  { name: 'k1-topleft', cls: 'small', x: 857, y: 490 },
  { name: 'k3-topright', cls: 'small', x: 1061, y: 490 },
  { name: 'k5-centre', cls: 'small', x: 959, y: 561 },
  { name: 'k0-bottom', cls: 'small', x: 959, y: 703 },
  { name: 'card-TL', cls: 'large', x: 797, y: 385 },
  { name: 'card-BR', cls: 'large', x: 1121, y: 810 },
];
const REPS = Number(process.argv[2] ?? 6);
const OUT = '/private/tmp/claude-501/-Users-georg-pikvm-mcp-server/69f79ce5-6389-4285-9eb8-047c6e09ea53/scratchpad/tap-bias.jsonl';
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

async function main() {
  const sess = await connectIpadSession();
  const client = new PiKVMClient(loadConfig().pikvm);
  const geom = await setupGreyScene(sess, client);
  const profile = await loadProfile('./data/ballistics.json').catch(() => null);
  await fs.writeFile(OUT, '');

  // Capture taps as they arrive; each trial takes the most recent one.
  let lastTap: TapEvent | null = null;
  sess.onTapEvent = (ev) => { lastTap = ev; };

  console.error(`TAP BIAS: ${TARGETS.length} targets x ${REPS} reps  (tight ${JSON.stringify(geom.tight)})\n`);
  const rows: Array<Record<string, number | string>> = [];
  for (let r = 1; r <= REPS; r++) {
    for (const t of TARGETS) {
      const mv = await moveToPixel(client, { x: t.x, y: t.y }, { strategy: 'curve-one-shot', profile: profile ?? undefined });
      const detected = mv.finalDetectedPosition;
      if (!detected) { console.error(`  r${r} ${t.name}: no detection — skipped`); continue; }
      lastTap = null;
      await client.mouseClick('left');
      // wait for the tap event to arrive from the app
      for (let w = 0; w < 30 && !lastTap; w++) await sleep(100);
      if (!lastTap) { console.error(`  r${r} ${t.name}: NO TAP EVENT — skipped`); continue; }
      const tapHdmi = geom.ipadToHdmi((lastTap as TapEvent).x, (lastTap as TapEvent).y);
      const row = {
        rep: r, target: t.name, cls: t.cls, tx: t.x, ty: t.y,
        dx: Number(detected.x.toFixed(1)), dy: Number(detected.y.toFixed(1)),
        tapx: Number(tapHdmi.x.toFixed(1)), tapy: Number(tapHdmi.y.toFixed(1)),
        biasX: Number((tapHdmi.x - detected.x).toFixed(1)),      // tap vs what the gate sees
        biasY: Number((tapHdmi.y - detected.y).toFixed(1)),
        missX: Number((tapHdmi.x - t.x).toFixed(1)),             // what the user experiences
        missY: Number((tapHdmi.y - t.y).toFixed(1)),
        residual: Number(Math.hypot(detected.x - t.x, detected.y - t.y).toFixed(1)),
      };
      rows.push(row);
      await fs.appendFile(OUT, JSON.stringify(row) + '\n');
      console.error(`  r${r} ${t.name.padEnd(12)} resid ${String(row.residual).padStart(5)}px  bias (${String(row.biasX).padStart(6)},${String(row.biasY).padStart(6)})  miss (${String(row.missX).padStart(6)},${String(row.missY).padStart(6)})`);
    }
  }

  const num = (k: string, f: (r: any) => boolean = () => true) => rows.filter(f).map((r) => r[k] as number);
  console.error('\n===== BIAS (actual tap - detected) =====');
  console.error(`  ALL      n=${rows.length}  median (${med(num('biasX')).toFixed(1)}, ${med(num('biasY')).toFixed(1)})  |bias| ${Math.hypot(med(num('biasX')), med(num('biasY'))).toFixed(1)}px`);
  for (const cls of ['small', 'large'] as const) {
    const f = (r: any) => r.cls === cls;
    console.error(`  ${cls.padEnd(8)} n=${num('biasX', f).length}  median (${med(num('biasX', f)).toFixed(1)}, ${med(num('biasY', f)).toFixed(1)})`);
  }
  console.error('\n  per position (constant bias => these agree; position-dependent => they diverge):');
  for (const t of TARGETS) {
    const f = (r: any) => r.target === t.name;
    const bx = num('biasX', f), by = num('biasY', f);
    if (!bx.length) continue;
    console.error(`    ${t.name.padEnd(12)} n=${bx.length} bias (${med(bx).toFixed(1)}, ${med(by).toFixed(1)})  spread x ${(Math.max(...bx) - Math.min(...bx)).toFixed(1)} y ${(Math.max(...by) - Math.min(...by)).toFixed(1)}`);
  }
  console.error('\n===== MISS (actual tap - target) — what the user experiences =====');
  for (const cls of ['small', 'large'] as const) {
    const f = (r: any) => r.cls === cls;
    const mx = num('missX', f), my = num('missY', f);
    if (!mx.length) continue;
    const dists = mx.map((v, i) => Math.hypot(v, my[i]));
    console.error(`  ${cls.padEnd(8)} median miss (${med(mx).toFixed(1)}, ${med(my).toFixed(1)})  |miss| median ${med(dists).toFixed(1)}px  max ${Math.max(...dists).toFixed(1)}px`);
  }
  console.error(`\n  raw: ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error('FATAL: ' + e); process.exit(2); });
