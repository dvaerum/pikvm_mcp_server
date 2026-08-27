// Diagnostic: how many crops does runCascade's grid actually batch into
// ONE inference call, on real captured frames? (task_78184455df4e)
//
// Run from the repo root (reuses its own node_modules):
//   npx tsx scratch/cpu-inference-speedup/grid-size-check.mts
import { readFileSync } from 'node:fs';
import { detectIpadRegion, NATIVE_MARGIN } from '../../src/pikvm/ipad-region-detect.js';

const GRID_STRIDE = 48;
const CASCADE_CROP = 96;

async function main() {
  const files = [
    'data/openloopshape-real/frame-lower-left-01.jpg',
    'data/openloopshape-real/frame-mid-center-01.jpg',
  ];
  for (const f of files) {
    const jpeg = readFileSync(f);
    const r = await detectIpadRegion(jpeg);
    const reg = { x: r.x + NATIVE_MARGIN, y: r.y + NATIVE_MARGIN, w: r.w - 2 * NATIVE_MARGIN, h: r.h - 2 * NATIVE_MARGIN };
    const half = CASCADE_CROP / 2;
    const axis = (lo: number, hi: number, frameMax: number): number[] => {
      const raw: number[] = [];
      for (let v = lo; v < hi; v += GRID_STRIDE) raw.push(v);
      raw.push(hi);
      const seen = new Set<number>(), out: number[] = [];
      for (const v of raw) {
        const c = Math.round(Math.max(half, Math.min(frameMax - half, v)));
        if (!seen.has(c)) { seen.add(c); out.push(c); }
      }
      return out;
    };
    const ys = axis(reg.y, reg.y + reg.h, r.frameH);
    const xs = axis(reg.x, reg.x + reg.w, r.frameW);
    const N = xs.length * ys.length;
    console.log(`${f}: frame=${r.frameW}x${r.frameH} region=${reg.w}x${reg.h} -> grid ${xs.length} x ${ys.length} = N=${N} crops/batch`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
