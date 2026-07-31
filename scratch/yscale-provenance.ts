/** Task #39 PROVENANCE — is the ~3.6% Y overshoot a STATIC miscalibration of
 *  Y_SCALE, or DRIFT in the iPad-in-HDMI geometry?
 *
 * Y_SCALE (curve-mover.ts) is documented as "Y displacement = X x this ... the
 * HDMI aspect-mapping ratio, ~0.965". So the truth we need is the real Y:X
 * displacement ratio. Two INDEPENDENT reads, no corner slams anywhere:
 *
 *  A. GEOMETRIC — from iPadCollector's hello (logical resolution) + the detected
 *     tight region: scaleHdmiPerLogical.y / .x. If the HDMI mapping preserves the
 *     iPad's aspect this is 1.000 and Y_SCALE=0.965 is simply wrong. Also prints
 *     the tight region so it can be compared against the documented
 *     {x:610,y:58,w:692,h:956} — a changed region would mean DRIFT.
 *
 *  B. EMPIRICAL — emit the SAME mickeys on X and on Y and measure the resulting
 *     displacement with getCursor GROUND TRUTH (not the detector, which has its
 *     own bias). ratio = |dY| / |dX|. This measures exactly what Y_SCALE claims.
 *
 * usage: npx tsx scratch/yscale-provenance.ts [reps]
 */
import { connectIpadSession, setupGreyScene, readCursorHdmi, sleep } from '../benches/lib/groundtruth.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { loadConfig } from '../src/config.js';
import { Y_SCALE } from '../src/pikvm/curve-mover.js';

const DOCUMENTED = { x: 610, y: 58, w: 692, h: 956 };
const REPS = Number(process.argv[2] ?? 6);
const BURST = 127;          // one full report per emit
const EMITS = 2;            // 2 full reports ~ 314px on X — well clear of noise
const PACE = 110;

async function main() {
  const sess = await connectIpadSession();
  const client = new PiKVMClient(loadConfig().pikvm);
  const geom = await setupGreyScene(sess, client);

  // ---------- A. GEOMETRIC ----------
  const t = geom.tight, s = geom.scaleHdmiPerLogical;
  const geoRatio = s.y / s.x;
  console.error('=== A. GEOMETRIC (iPadCollector hello + detected tight region) ===');
  console.error(`  tight region : {x:${t.x.toFixed(0)}, y:${t.y.toFixed(0)}, w:${t.w.toFixed(0)}, h:${t.h.toFixed(0)}}`);
  console.error(`  documented   : {x:${DOCUMENTED.x}, y:${DOCUMENTED.y}, w:${DOCUMENTED.w}, h:${DOCUMENTED.h}}`);
  console.error(`  delta        : dx ${(t.x - DOCUMENTED.x).toFixed(0)}  dy ${(t.y - DOCUMENTED.y).toFixed(0)}  dw ${(t.w - DOCUMENTED.w).toFixed(0)}  dh ${(t.h - DOCUMENTED.h).toFixed(0)}`);
  console.error(`  hdmi px per logical px: x ${s.x.toFixed(5)}  y ${s.y.toFixed(5)}`);
  console.error(`  geometric Y:X ratio    : ${geoRatio.toFixed(5)}   (hardcoded Y_SCALE = ${Y_SCALE})`);
  console.error(`  Y_SCALE error vs geometric: ${(100 * (geoRatio / Y_SCALE - 1)).toFixed(2)}%\n`);

  // ---------- B. EMPIRICAL, via getCursor ground truth ----------
  console.error('=== B. EMPIRICAL (equal mickeys on X vs Y, measured by getCursor GT) ===');
  const runAxis = async (axis: 'x' | 'y'): Promise<number> => {
    // park mid-region so a 2-report burst stays well inside — never near a corner
    const home = { x: t.x + t.w * (axis === 'x' ? 0.2 : 0.5), y: t.y + t.h * (axis === 'x' ? 0.5 : 0.2) };
    const ok = (p: any) => p && p.ipadHdmi && Number.isFinite(p.ipadHdmi.x) && Number.isFinite(p.ipadHdmi.y);
    const at = (p: any) => p.ipadHdmi as { x: number; y: number };
    // wake tracking: iPadCollector reports (0,0) until the pointer has moved
    for (let w = 0; w < 6; w++) { await client.mouseMoveRelative(w % 2 ? -18 : 18, w % 2 ? -12 : 12); await sleep(80); }
    await sleep(250);
    // steer to home with small relative nudges (no absolute moves on iPad, no slams)
    for (let i = 0; i < 40; i++) {
      const cur = await readCursorHdmi(sess, geom);
      if (!ok(cur)) { await client.mouseMoveRelative(6, 6); await sleep(120); continue; }
      const dx = home.x - at(cur).x, dy = home.y - at(cur).y;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) break;
      if (Math.hypot(dx, dy) < 40) break;
      await client.mouseMoveRelative(Math.max(-100, Math.min(100, Math.round(dx / 2))), Math.max(-100, Math.min(100, Math.round(dy / 2))));
      await sleep(90);
    }
    await sleep(300);
    const p0 = await readCursorHdmi(sess, geom);
    if (!ok(p0)) return NaN;
    for (let i = 0; i < EMITS; i++) {
      await client.mouseMoveRelative(axis === 'x' ? BURST : 0, axis === 'y' ? BURST : 0);
      await sleep(PACE);
    }
    await sleep(400);
    const p1 = await readCursorHdmi(sess, geom);
    if (!ok(p1)) return NaN;
    return axis === 'x' ? at(p1).x - at(p0).x : at(p1).y - at(p0).y;
  };

  const dxs: number[] = [], dys: number[] = [];
  for (let r = 1; r <= REPS; r++) {
    const dx = await runAxis('x'); const dy = await runAxis('y');
    if (Number.isFinite(dx) && Math.abs(dx) > 100) dxs.push(Math.abs(dx));
    if (Number.isFinite(dy) && Math.abs(dy) > 100) dys.push(Math.abs(dy));
    console.error(`  rep ${r}: |dX| ${Number.isFinite(dx) ? Math.abs(dx).toFixed(1) : '?'}px   |dY| ${Number.isFinite(dy) ? Math.abs(dy).toFixed(1) : '?'}px   ratio ${Number.isFinite(dx) && Number.isFinite(dy) && dx ? (Math.abs(dy) / Math.abs(dx)).toFixed(4) : '?'}`);
  }
  const med = (a: number[]) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
  const mx = med(dxs), my = med(dys), empRatio = my / mx;
  console.error(`\n  median |dX| ${mx.toFixed(1)}px  |dY| ${my.toFixed(1)}px  ->  empirical Y:X ratio ${empRatio.toFixed(4)}`);
  console.error(`  hardcoded Y_SCALE ${Y_SCALE}  ->  error ${(100 * (empRatio / Y_SCALE - 1)).toFixed(2)}%`);
  console.error(`\n  (held-out validation measured the Y overshoot at 3.64%; 0.965 x 1.0364 = ${(0.965 * 1.0364).toFixed(4)})`);
  process.exit(0);
}
main().catch((e) => { console.error('FATAL: ' + e); process.exit(2); });
