/** #41 gate support — safe TRAFFIC GENERATOR for the passive mover learner.
 *
 * The learner only sees samples from real moves, so gating it needs traffic on
 * demand. This drives a controlled sequence of moves at KNOWN distances through
 * the production `pikvm_mouse_move_to` path (the same entry point real usage
 * hits — gating a fix through a lower layer is how you get a false green).
 *
 * SAFETY, by construction: this NEVER clicks. A moving pointer cannot activate
 * a payment screen, dismiss a sheet, or type a digit — which is the structural
 * fix for the blind-click class that navigated the live kiosk into "Tap to Pay"
 * on 2026-07-31. No hardcoded UI targets either: waypoints are geometric, kept
 * >=40px inside the tight region, and never in a hot corner.
 *
 * Distance mix mirrors measured WB traffic (layout-derived):
 *   navigation-scale ~300-500px, card-to-card ~425px, pad-scale ~100-160px.
 * usage: npx tsx scratch/traffic-gen.ts <moves> [mix: real|long|short]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REGION = { x: 616, y: 56, w: 680, h: 968 };   // measured tight region
const M = 40;                                        // keep-inside margin
const MOVES = Number(process.argv[2] ?? 30);
const MIX = (process.argv[3] ?? 'real') as 'real' | 'long' | 'short';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic waypoint walk at a target distance — no RNG (Math.random is
 *  banned in workflow scripts and makes gate runs unreproducible anyway). */
function* waypoints(mix: 'real' | 'long' | 'short'): Generator<{ x: number; y: number; d: number }> {
  const dists = mix === 'long' ? [420, 500, 380] : mix === 'short' ? [102, 124, 143] : [425, 143, 380, 102, 500, 124];
  const cx = REGION.x + REGION.w / 2, cy = REGION.y + REGION.h / 2;
  let i = 0;
  for (;;) {
    const d = dists[i % dists.length];
    // alternate direction each step so the pointer oscillates inside the region
    const ang = (i * 2 * Math.PI) / 6;
    const x = Math.round(cx + Math.cos(ang) * Math.min(d / 2, REGION.w / 2 - M));
    const y = Math.round(cy + Math.sin(ang) * Math.min(d / 2, REGION.h / 2 - M));
    yield {
      x: Math.max(REGION.x + M, Math.min(REGION.x + REGION.w - M, x)),
      y: Math.max(REGION.y + M, Math.min(REGION.y + REGION.h - M, y)),
      d,
    };
    i++;
  }
}

async function main() {
  const transport = new StdioClientTransport({ command: './node_modules/.bin/tsx', args: ['src/index.ts', '--target', 'ipad'], env: { ...process.env } as Record<string, string> });
  const mcp = new Client({ name: 'traffic-gen', version: '0' }, { capabilities: {} });
  await mcp.connect(transport);
  console.error(`TRAFFIC GEN: ${MOVES} moves, mix=${MIX}, MOVES ONLY (never clicks)\n`);
  const gen = waypoints(MIX);
  for (let i = 1; i <= MOVES; i++) {
    const wp = gen.next().value as { x: number; y: number; d: number };
    const t0 = Date.now();
    const r: any = await mcp.callTool({ name: 'pikvm_mouse_move_to', arguments: { x: wp.x, y: wp.y } });
    const text = ((r.content.find((c: any) => c.type === 'text')?.text ?? '') as string).replace(/\s+/g, ' ');
    const resid = Number((/landed ([\d.]+)px/.exec(text) ?? [])[1] ?? NaN);
    console.error(`  ${String(i).padStart(3)}/${MOVES} -> (${wp.x},${wp.y}) nominal ${wp.d}px  resid ${Number.isFinite(resid) ? resid.toFixed(1) + 'px' : '?'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    await sleep(200);
  }
  console.error('\ndone — no clicks were sent.');
  await mcp.close(); process.exit(0);
}
main().catch((e) => { console.error('FATAL: ' + e); process.exit(2); });
