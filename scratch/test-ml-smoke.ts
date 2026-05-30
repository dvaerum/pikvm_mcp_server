/**
 * TypeScript smoke test for findCursorByML.
 * Replays the same test that the Python ml/test-onnx-on-unseen.py
 * runs, to confirm onnxruntime-node produces equivalent results.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { findCursorByML } from '../src/pikvm/cursor-ml-detect.js';

const ROOT = process.cwd();
const FRAME_DIR = path.join(ROOT, 'data', 'phase312-acceptance', '2026-05-13_04-58-34');

interface TestCase {
  file: string;
  cursor_gt: { x: number; y: number };
}

const TEST_CASES: TestCase[] = [
  { file: 'mid_left.jpg', cursor_gt: { x: 1007, y: 777 } },
  { file: 'mid_upleft.jpg', cursor_gt: { x: 1026, y: 653 } },
  { file: 'mid_above.jpg', cursor_gt: { x: 1150, y: 633 } },
];

console.error('=== TypeScript ML smoke test ===');
for (const tc of TEST_CASES) {
  const buf = await fs.readFile(path.join(FRAME_DIR, tc.file));
  // Hint = ground truth (best case: hint IS the cursor)
  const start = Date.now();
  const r = await findCursorByML(buf, 1680, 1050, { hint: tc.cursor_gt });
  const ms = Date.now() - start;
  if (r === null) {
    console.error(`  ${tc.file}: NULL (no detection)`);
  } else {
    const dist = Math.hypot(r.x - tc.cursor_gt.x, r.y - tc.cursor_gt.y);
    console.error(
      `  ${tc.file}: GT=(${tc.cursor_gt.x},${tc.cursor_gt.y}) pred=(${r.x},${r.y}) conf=${r.confidence.toFixed(3)} dist=${dist.toFixed(1)}px ${ms}ms`,
    );
  }
}

console.error('\n=== Offset hint test (hint 50 px off ground truth) ===');
const tc0 = TEST_CASES[0];
const buf = await fs.readFile(path.join(FRAME_DIR, tc0.file));
const hint = { x: tc0.cursor_gt.x + 50, y: tc0.cursor_gt.y - 30 };
const r = await findCursorByML(buf, 1680, 1050, { hint });
if (r === null) {
  console.error('  NULL');
} else {
  const dist = Math.hypot(r.x - tc0.cursor_gt.x, r.y - tc0.cursor_gt.y);
  console.error(
    `  hint=(${hint.x},${hint.y}) GT=(${tc0.cursor_gt.x},${tc0.cursor_gt.y}) pred=(${r.x},${r.y}) conf=${r.confidence.toFixed(3)} dist=${dist.toFixed(1)}px`,
  );
}

process.exit(0);
