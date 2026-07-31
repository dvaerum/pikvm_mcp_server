/** GATE for the curveScaleY=1.0364 recalibration. Run ONCE PER CHECKOUT
 * (main, then the branch) and compare — the constant is baked in, so the arms
 * are the two builds, not two options.
 *
 * ARM A — OPEN-LOOP (what the constant actually changes): the held-out
 *   geometries from task #39, pure one-shot (correctGatePx: Infinity, honored on
 *   main since 95ec05f). Reports residual + the would-SKIP rate (>25px), which
 *   is the 63%->1% number under test.
 * ARM B — CLICK PATH (what the user feels): the same dead-band geometry through
 *   the real click_at. With f=1.0 merged, main's 27px shot is RESCUED by a
 *   correction, so both builds should CLICK — the difference shows up as
 *   LATENCY (a correction costs ~1.37s) and as the landed residual.
 * ARM C — NO REGRESSION on short / PIN-scale moves, which have little dy and so
 *   must be essentially unaffected.
 *
 * usage: npx tsx scratch/gate-yscale.ts <label> [reps]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { moveByCurveOneShot, planWakeEmits, Y_SCALE } from '../src/pikvm/curve-mover.js';
import { execSync } from 'child_process';

const DEVICE = 'CF2B815D-7960-5B60-987B-FA2DC9A65353', APP = 'dk.vammencamping.sumuppayment';
type Geo = { name: string; from: { x: number; y: number }; to: { x: number; y: number } };
const HELDOUT: Geo[] = [
  { name: 'H1-vert-down', from: { x: 960, y: 120 }, to: { x: 960, y: 980 } },
  { name: 'H2-vert-up', from: { x: 960, y: 980 }, to: { x: 960, y: 120 } },
  { name: 'H3-diag-down', from: { x: 700, y: 150 }, to: { x: 1250, y: 947 } },
  { name: 'H4-diag-up', from: { x: 1250, y: 947 }, to: { x: 700, y: 150 } },
  { name: 'H5-horiz', from: { x: 650, y: 550 }, to: { x: 1280, y: 550 } },
];
// short / PIN-key-scale moves: little dy, must be unaffected by a Y-scale change
const SHORT: Geo[] = [
  { name: 'S1-short-diag', from: { x: 900, y: 500 }, to: { x: 1000, y: 600 } },
  { name: 'S2-pinkey-hop', from: { x: 857, y: 561 }, to: { x: 1061, y: 631 } },   // key 1 -> key 6
  { name: 'S3-pinkey-row', from: { x: 959, y: 490 }, to: { x: 959, y: 703 } },    // key 2 -> key 0
];
const LABEL = process.argv[2] ?? 'unlabelled';
const REPS = Number(process.argv[3] ?? 8);
const SKIP_GATE = 25;
const OUT = `/private/tmp/claude-501/-Users-georg-pikvm-mcp-server/69f79ce5-6389-4285-9eb8-047c6e09ea53/scratchpad/gate-yscale-${LABEL}.jsonl`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const relaunch = () => execFileSync('xcrun', ['devicectl', 'device', 'process', 'launch', '--terminate-existing', '--device', DEVICE, APP], { stdio: 'ignore' });
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

async function main() {
  await fs.writeFile(OUT, '');
  const c = new PiKVMClient(loadConfig().pikvm);
  const profile = await loadProfile('./data/ballistics.json').catch(() => null);
  const SHA = execSync('git rev-parse --short HEAD').toString().trim();
  console.error(`GATE [${LABEL}]  build ${SHA}  Y_SCALE=${Y_SCALE}\n`);

  const openLoop = async (set: Geo[], tag: string) => {
    const per: Record<string, number[]> = {};
    for (let r = 1; r <= REPS; r++) {
      for (const g of set) {
        relaunch(); await sleep(2600);
        for (const [dx, dy] of planWakeEmits()) { await c.mouseMoveRelative(dx, dy); await sleep(70); }
        await sleep(250);
        try { await moveToPixel(c, g.from, { strategy: 'curve-one-shot', profile: profile ?? undefined }); } catch {}
        await sleep(400);
        const res = await moveByCurveOneShot(c, g.to, { correctGatePx: Infinity, profile: profile ?? undefined } as any);
        if (typeof res.finalResidualPx === 'number') (per[g.name] ??= []).push(res.finalResidualPx);
        await fs.appendFile(OUT, JSON.stringify({ arm: tag, label: LABEL, rep: r, geo: g.name, resid: res.finalResidualPx }) + '\n');
      }
    }
    const all = Object.values(per).flat();
    const skips = all.filter((x) => x > SKIP_GATE).length;
    console.error(`--- ARM ${tag} (open-loop, pure one-shot) ---`);
    for (const [n, v] of Object.entries(per)) console.error(`  ${n.padEnd(14)} n=${v.length} median ${med(v).toFixed(1)}px  skips ${v.filter((x) => x > SKIP_GATE).length}/${v.length}`);
    console.error(`  TOTAL n=${all.length} median ${med(all).toFixed(1)}px  would-SKIP ${skips}/${all.length} = ${(100 * skips / all.length).toFixed(0)}%\n`);
    return { median: med(all), skips, n: all.length };
  };

  const A = await openLoop(HELDOUT, 'A-heldout');
  const C = await openLoop(SHORT, 'C-short');

  // ---- ARM B: real click path ----
  console.error('--- ARM B (real click_at, dead-band geometry) ---');
  const transport = new StdioClientTransport({ command: './node_modules/.bin/tsx', args: ['src/index.ts', '--target', 'ipad'], env: { ...process.env } as Record<string, string> });
  const mcp = new Client({ name: 'gate-yscale', version: '0' }, { capabilities: {} });
  await mcp.connect(transport);
  const txt = (r: any) => ((r.content.find((x: any) => x.type === 'text')?.text ?? '') as string).replace(/\s+/g, ' ');
  const lat: number[] = [], resids: number[] = []; let skipped = 0;
  for (let t = 1; t <= Math.min(REPS, 6); t++) {
    relaunch(); await sleep(2600);
    await mcp.callTool({ name: 'pikvm_mouse_move_to', arguments: { x: 960, y: 120 } });
    await sleep(500);
    const t0 = Date.now();
    const out = txt(await mcp.callTool({ name: 'pikvm_mouse_click_at', arguments: { x: 960, y: 980 } }));
    const ms = Date.now() - t0;
    const resid = Number((/landed ([\d.]+)px/.exec(out) ?? [])[1] ?? NaN);
    const skip = /NOT performed/i.test(out);
    if (skip) skipped++;
    if (Number.isFinite(resid)) resids.push(resid);
    lat.push(ms);
    await fs.appendFile(OUT, JSON.stringify({ arm: 'B-click', label: LABEL, trial: t, resid, skip, ms }) + '\n');
    console.error(`  t${t}: ${skip ? 'SKIPPED' : 'clicked'} ${Number.isFinite(resid) ? resid.toFixed(1) + 'px' : '?'} (${(ms / 1000).toFixed(2)}s)`);
  }
  console.error(`  median ${med(resids).toFixed(1)}px, latency ${(med(lat) / 1000).toFixed(2)}s, skipped ${skipped}/${lat.length}`);
  console.error(`\n===== [${LABEL}] ${SHA} Y_SCALE=${Y_SCALE} | held-out ${A.median.toFixed(1)}px skip ${A.skips}/${A.n} | short ${C.median.toFixed(1)}px skip ${C.skips}/${C.n} | click ${med(resids).toFixed(1)}px @ ${(med(lat) / 1000).toFixed(2)}s`);
  console.error(`  raw: ${OUT}`);
  await mcp.close(); process.exit(0);
}
main().catch((e) => { console.error('FATAL: ' + e); process.exit(2); });
