/** Find a DEAD-BAND geometry: a park->target move whose PURE open-loop residual
 * lands in [25,30) — rejected by the click gate (maxResidualPx=25) but ignored
 * by the mover (correctGatePx=30). That geometry is the gate case for the
 * f=1.0 fix: it must go from "honest skip" to "corrected and landed".
 *
 * The open-loop error is systematic per geometry (17.3-19.2px measured on
 * park->gear, N=8/arm), so a sweep of start/target pairs should surface the
 * spread of residuals the curve produces across the iPad region.
 * usage: npx tsx scratch/deadband-hunt.ts [repsPerPair]
 */
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { moveByCurveOneShot, planWakeEmits } from '../src/pikvm/curve-mover.js';

const DEVICE = 'CF2B815D-7960-5B60-987B-FA2DC9A65353', APP = 'dk.vammencamping.sumuppayment';
// iPad tight region in the 1920x1080 frame: {x:610,y:58,w:692,h:956}
const PAIRS: Array<{ name: string; from: { x: number; y: number }; to: { x: number; y: number } }> = [
  { name: 'TL->BR', from: { x: 700, y: 150 }, to: { x: 1250, y: 947 } },
  { name: 'BR->TL', from: { x: 1250, y: 947 }, to: { x: 700, y: 150 } },
  { name: 'TR->BL', from: { x: 1250, y: 150 }, to: { x: 700, y: 947 } },
  { name: 'BL->TR', from: { x: 700, y: 947 }, to: { x: 1250, y: 150 } },
  { name: 'mid->gear', from: { x: 960, y: 300 }, to: { x: 1250, y: 947 } },
  { name: 'gear->mid', from: { x: 1250, y: 947 }, to: { x: 960, y: 300 } },
  { name: 'vert-long', from: { x: 960, y: 120 }, to: { x: 960, y: 980 } },
  { name: 'horiz-long', from: { x: 650, y: 550 }, to: { x: 1280, y: 550 } },
  { name: 'short-diag', from: { x: 900, y: 500 }, to: { x: 1100, y: 700 } },
  { name: 'mid->key5', from: { x: 700, y: 200 }, to: { x: 959, y: 561 } },
];
const REPS = Number(process.argv[2] ?? 2);
const SCALE_Y = Number(process.argv[3] ?? 1);   // curveScaleY under test (>1 emits less)
const OUT = '/private/tmp/claude-501/-Users-georg-pikvm-mcp-server/69f79ce5-6389-4285-9eb8-047c6e09ea53/scratchpad/deadband-hunt.jsonl';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const c = new PiKVMClient(loadConfig().pikvm);
  const profile = await loadProfile('./data/ballistics.json').catch(() => null);
  await fs.writeFile(OUT, '');
  const byPair: Record<string, number[]> = {};
  console.error(`DEAD-BAND HUNT: ${PAIRS.length} geometries x ${REPS} reps, PURE one-shot, curveScaleY=${SCALE_Y}\n`);

  for (let r = 1; r <= REPS; r++) {
    for (const p of PAIRS) {
      execFileSync('xcrun', ['devicectl', 'device', 'process', 'launch', '--terminate-existing', '--device', DEVICE, APP], { stdio: 'ignore' });
      await sleep(2600);
      for (const [dx, dy] of planWakeEmits()) { await c.mouseMoveRelative(dx, dy); await sleep(70); }
      await sleep(300);
      try { await moveToPixel(c, p.from, { strategy: 'curve-one-shot', profile: profile ?? undefined }); } catch {}
      await sleep(400);
      const res = await moveByCurveOneShot(c, p.to, { correctGatePx: Infinity, curveScaleY: SCALE_Y, profile: profile ?? undefined } as any);
      const resid = res.finalResidualPx;
      if (typeof resid === 'number') (byPair[p.name] ??= []).push(resid);
      await fs.appendFile(OUT, JSON.stringify({ rep: r, pair: p.name, from: p.from, to: p.to, resid, landed: res.finalDetectedPosition }) + '\n');
      const band = typeof resid === 'number' && resid >= 25 && resid < 30 ? '  <<< DEAD BAND' : (typeof resid === 'number' && resid > 25 ? '  (>25 skip)' : '');
      console.error(`r${r} ${p.name.padEnd(11)} ${resid === null ? '  ?  ' : resid.toFixed(1).padStart(5)}px${band}`);
    }
  }

  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  console.error('\n===== OPEN-LOOP RESIDUAL BY GEOMETRY =====');
  for (const [name, v] of Object.entries(byPair)) {
    const m = med(v);
    const tag = m >= 25 && m < 30 ? '  <<< DEAD-BAND GATE CASE' : m > 25 ? '  (skips today)' : '';
    console.error(`  ${name.padEnd(11)} n=${v.length} median ${m.toFixed(1)}px  [${v.map((x) => x.toFixed(1)).join(', ')}]${tag}`);
  }
  console.error(`  raw: ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error('FATAL: ' + e); process.exit(2); });
