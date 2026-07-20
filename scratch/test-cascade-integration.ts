/** Validate the PRODUCTION cascade path (findCursorByV8FullFrame + PIKVM_ML_CASCADE=1)
 * matches the standalone cascade-eval. hc13 must return null; clean-cursor + books
 * must detect near the true cursor. Run with:
 *   PIKVM_ML_CASCADE=1 PIKVM_ML_V8_MODEL=ml/cursor-v14-ep05.onnx \
 *   PIKVM_ML_VERIFIER_MODEL=ml/crop-verifier-sel.onnx tsx scratch/test-cascade-integration.ts
 */
import { readFileSync } from 'node:fs';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';

const cases: [string, { x: number; y: number } | null][] = [
  ['scratch/hc13.jpg', null],
  ['scratch/hc15.jpg', null],
  ['scratch/hc17.jpg', null],
  ['scratch/hc18.jpg', null],
  ['scratch/clean-cursor.jpg', { x: 620, y: 432 }],
  ['scratch/instrumented-bench/MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg', { x: 757, y: 846 }],
];
let ok = 0;
for (const [f, exp] of cases) {
  const r = await findCursorByV8FullFrame(readFileSync(f), 1920, 1080);
  let pass: boolean;
  if (!exp) pass = r === null;
  else pass = r !== null && Math.hypot(r.x - exp.x, r.y - exp.y) < 80;
  if (pass) ok++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${f.split('/').pop()}  expect=${exp ? `${exp.x},${exp.y}` : 'null'}  got=${r ? `${r.x},${r.y} v=${r.presence.toFixed(2)}` : 'null'}`);
}
console.log(`\n=== ${ok}/${cases.length} ===`);
