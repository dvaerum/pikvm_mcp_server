/** Is the 25.3px a WAKE effect or a LONG-MOVE effect? Paired, interleaved.
 *
 * The gate compared a post-wake shot (park -> gear, ~700px) against "warm" 2nd/3rd
 * shots that start ALREADY AT the gear (~0px move). That conflates woken-ness with
 * move DISTANCE. Two arms, same long move, same target, differing only in fade:
 *   VISIBLE: park, cursor still visible -> curve one-shot to gear   (woken=false)
 *   FADED  : park, wait out the fade    -> curve one-shot to gear   (woken=true)
 * Pure one-shot in both arms (correctGatePx=Infinity) so we measure the OPEN-LOOP
 * error, not the correction's cleanup.
 * usage: npx tsx scratch/wake-vs-distance.ts <trialsPerArm>
 */
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { moveByCurveOneShot, planWakeEmits } from '../src/pikvm/curve-mover.js';

const DEVICE = 'CF2B815D-7960-5B60-987B-FA2DC9A65353', APP = 'dk.vammencamping.sumuppayment';
const PARK = { x: 960, y: 300 }, GEAR = { x: 1250, y: 947 };
const FADE_MS = 15000;
const N = Number(process.argv[2] ?? 8);
const GATE = Number(process.argv[3] ?? Infinity);   // correctGatePx under test
const OUT = '/private/tmp/claude-501/-Users-georg-pikvm-mcp-server/69f79ce5-6389-4285-9eb8-047c6e09ea53/scratchpad/wake-vs-distance.jsonl';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const c = new PiKVMClient(loadConfig().pikvm);
  const profile = await loadProfile('./data/ballistics.json').catch(() => null);
  await fs.writeFile(OUT, '');
  const R: Record<string, number[]> = { VISIBLE: [], FADED: [] };
  console.error(`WAKE vs DISTANCE: N=${N}/arm, park(${PARK.x},${PARK.y}) -> gear(${GEAR.x},${GEAR.y}), gate=${GATE}\n`);

  for (let t = 1; t <= N; t++) {
    for (const arm of ['VISIBLE', 'FADED'] as const) {
      execFileSync('xcrun', ['devicectl', 'device', 'process', 'launch', '--terminate-existing', '--device', DEVICE, APP], { stdio: 'ignore' });
      await sleep(2600);
      for (const [dx, dy] of planWakeEmits()) { await c.mouseMoveRelative(dx, dy); await sleep(70); }
      await sleep(300);
      try { await moveToPixel(c, PARK, { strategy: 'curve-one-shot', profile: profile ?? undefined }); } catch {}
      await sleep(400);
      if (arm === 'FADED') await sleep(FADE_MS);
      const r = await moveByCurveOneShot(c, GEAR, { correctGatePx: GATE, profile: profile ?? undefined } as any);
      const resid = r.finalResidualPx;
      const woken = / \(after faded-cursor wake\)/.test(r.message ?? '');
      if (typeof resid === 'number') R[arm].push(resid);
      await fs.appendFile(OUT, JSON.stringify({ trial: t, arm, resid, woken, msg: r.message }) + '\n');
      console.error(`t${String(t).padStart(2)} ${arm.padEnd(7)} resid ${resid === null ? '  ?  ' : resid.toFixed(1).padStart(5)}px  woken=${woken ? 'Y' : 'n'}`);
    }
  }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  console.error('\n===== OPEN-LOOP RESIDUAL, same long move =====');
  for (const arm of ['VISIBLE', 'FADED'] as const) {
    const v = R[arm];
    console.error(`  ${arm.padEnd(7)}: n=${v.length} median ${med(v).toFixed(1)}px  over25=${v.filter((x) => x > 25).length}/${v.length}  [${v.map((x) => x.toFixed(1)).join(', ')}]`);
  }
  console.error(`  raw: ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error('FATAL: ' + e); process.exit(2); });
