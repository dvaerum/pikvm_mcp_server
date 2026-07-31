/** Task #39 — HELD-OUT validation of the ~3% Y-axis overshoot.
 *
 * Protocol (per manager, to avoid the session-overfit that killed past "gains"):
 *   PHASE 1 DERIVE   : fit curveScaleY on the DERIVE geometry set ONLY.
 *   PHASE 2 VALIDATE : measure on a DIFFERENT, HELD-OUT geometry set, paired and
 *                      interleaved (control scaleY=1 vs treatment scaleY=fitted,
 *                      back-to-back within each rep so drift hits both arms).
 * Both directions of travel (the error sign follows dy). N>=80 shots per arm.
 * CORNER-FREE: every point stays >=40px inside the iPad tight region
 * {x:610,y:58,w:692,h:956} — we never slam the pointer to a hard corner
 * (that is the hot-corner that ejects the app).
 *
 * Reports residual medians/spread per arm AND the would-skip rate (residual >
 * maxResidualPx=25), which is the live click-rate impact.
 * usage: npx tsx scratch/yscale-validate.ts [repsPerHeldOutGeometry] [deriveReps]
 */
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { moveByCurveOneShot, planWakeEmits } from '../src/pikvm/curve-mover.js';

const DEVICE = 'CF2B815D-7960-5B60-987B-FA2DC9A65353', APP = 'dk.vammencamping.sumuppayment';
type Geo = { name: string; from: { x: number; y: number }; to: { x: number; y: number } };

// DERIVE set — used ONLY to fit the scale. Never measured for the verdict.
const DERIVE: Geo[] = [
  { name: 'D1-down', from: { x: 700, y: 200 }, to: { x: 700, y: 900 } },
  { name: 'D2-up', from: { x: 1200, y: 900 }, to: { x: 1200, y: 250 } },
  { name: 'D3-diag-down', from: { x: 800, y: 300 }, to: { x: 1150, y: 850 } },
  { name: 'D4-diag-up', from: { x: 1150, y: 850 }, to: { x: 800, y: 300 } },
];
// HELD-OUT set — never used for fitting. The verdict comes from these only.
const HELDOUT: Geo[] = [
  { name: 'H1-vert-down', from: { x: 960, y: 120 }, to: { x: 960, y: 980 } },
  { name: 'H2-vert-up', from: { x: 960, y: 980 }, to: { x: 960, y: 120 } },
  { name: 'H3-diag-down', from: { x: 700, y: 150 }, to: { x: 1250, y: 947 } },
  { name: 'H4-diag-up', from: { x: 1250, y: 947 }, to: { x: 700, y: 150 } },
  { name: 'H5-horiz', from: { x: 650, y: 550 }, to: { x: 1280, y: 550 } },  // dy=0 control: must NOT change
];
const REPS = Number(process.argv[2] ?? 16);        // 16 x 5 geometries = 80 shots/arm
const DERIVE_REPS = Number(process.argv[3] ?? 5);
const SKIP_GATE = 25;                              // maxResidualPx default
const OUT = '/private/tmp/claude-501/-Users-georg-pikvm-mcp-server/69f79ce5-6389-4285-9eb8-047c6e09ea53/scratchpad/yscale-validate.jsonl';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const relaunch = () => execFileSync('xcrun', ['devicectl', 'device', 'process', 'launch', '--terminate-existing', '--device', DEVICE, APP], { stdio: 'ignore' });
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

async function shoot(c: PiKVMClient, profile: any, g: Geo, scaleY: number) {
  for (const [dx, dy] of planWakeEmits()) { await c.mouseMoveRelative(dx, dy); await sleep(70); }
  await sleep(250);
  try { await moveToPixel(c, g.from, { strategy: 'curve-one-shot', profile: profile ?? undefined }); } catch {}
  await sleep(400);
  const r = await moveByCurveOneShot(c, g.to, { correctGatePx: Infinity, curveScaleY: scaleY, profile: profile ?? undefined } as any);
  const landed = r.finalDetectedPosition;
  return {
    resid: r.finalResidualPx,
    errY: landed ? landed.y - g.to.y : null,
    errX: landed ? landed.x - g.to.x : null,
    dy: g.to.y - g.from.y,
  };
}

async function main() {
  const c = new PiKVMClient(loadConfig().pikvm);
  const profile = await loadProfile('./data/ballistics.json').catch(() => null);
  await fs.writeFile(OUT, '');
  let shots = 0;
  const hygiene = async () => { if (shots % 10 === 0) { relaunch(); await sleep(2600); } shots++; };

  // ---------- PHASE 1: DERIVE ----------
  console.error(`PHASE 1 DERIVE — ${DERIVE.length} geometries x ${DERIVE_REPS} reps (fit only, never scored)\n`);
  const ratios: number[] = [];
  for (let r = 1; r <= DERIVE_REPS; r++) {
    for (const g of DERIVE) {
      await hygiene();
      const s = await shoot(c, profile, g, 1);
      if (s.errY !== null && s.dy !== 0) ratios.push(s.errY / s.dy);
      await fs.appendFile(OUT, JSON.stringify({ phase: 'derive', rep: r, geo: g.name, ...s }) + '\n');
      console.error(`  ${g.name.padEnd(13)} resid ${s.resid?.toFixed(1).padStart(5)}px  errY ${s.errY?.toFixed(1).padStart(6)}  errY/dy ${s.errY !== null && s.dy ? (100 * s.errY / s.dy).toFixed(2) + '%' : '-'}`);
    }
  }
  const ratio = med(ratios);
  const FITTED = 1 + ratio;
  console.error(`\n  fitted from DERIVE set only: median errY/dy = ${(100 * ratio).toFixed(2)}%  ->  curveScaleY = ${FITTED.toFixed(4)}  (n=${ratios.length})\n`);

  // ---------- PHASE 2: VALIDATE on held-out ----------
  console.error(`PHASE 2 VALIDATE — ${HELDOUT.length} held-out geometries x ${REPS} reps, paired control/treatment\n`);
  const arm: Record<string, number[]> = { control: [], treat: [] };
  const perGeo: Record<string, { control: number[]; treat: number[] }> = {};
  for (let r = 1; r <= REPS; r++) {
    for (const g of HELDOUT) {
      perGeo[g.name] ??= { control: [], treat: [] };
      for (const which of ['control', 'treat'] as const) {
        await hygiene();
        const s = await shoot(c, profile, g, which === 'control' ? 1 : FITTED);
        if (typeof s.resid === 'number') { arm[which].push(s.resid); perGeo[g.name][which].push(s.resid); }
        await fs.appendFile(OUT, JSON.stringify({ phase: 'validate', rep: r, geo: g.name, arm: which, scaleY: which === 'control' ? 1 : FITTED, ...s }) + '\n');
      }
      const cv = perGeo[g.name].control.at(-1), tv = perGeo[g.name].treat.at(-1);
      console.error(`  r${String(r).padStart(2)} ${g.name.padEnd(13)} control ${cv?.toFixed(1).padStart(5)}px   treat ${tv?.toFixed(1).padStart(5)}px`);
    }
  }

  const skips = (v: number[]) => v.filter((x) => x > SKIP_GATE).length;
  console.error(`\n===== HELD-OUT VALIDATION (fitted curveScaleY=${FITTED.toFixed(4)} from a DISJOINT geometry set) =====`);
  for (const which of ['control', 'treat'] as const) {
    const v = arm[which];
    const sorted = [...v].sort((a, b) => a - b);
    console.error(`  ${which.padEnd(8)} n=${v.length}  median ${med(v).toFixed(1)}px  p90 ${sorted[Math.floor(0.9 * sorted.length)]?.toFixed(1)}px  max ${sorted.at(-1)?.toFixed(1)}px  would-SKIP(>${SKIP_GATE}px) ${skips(v)}/${v.length} = ${(100 * skips(v) / v.length).toFixed(0)}%`);
  }
  console.error('\n  per geometry (median control -> treat):');
  for (const [name, v] of Object.entries(perGeo)) {
    console.error(`    ${name.padEnd(13)} ${med(v.control).toFixed(1)}px -> ${med(v.treat).toFixed(1)}px   skips ${skips(v.control)}/${v.control.length} -> ${skips(v.treat)}/${v.treat.length}`);
  }
  console.error(`\n  raw: ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error('FATAL: ' + e); process.exit(2); });
