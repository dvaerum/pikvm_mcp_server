/**
 * Regression guard: cursor-anchor.ts consolidates the "slam to a corner"
 * pattern (see docs/troubleshooting/ipad-safety-guards.md) into one place.
 * Before cursor-anchor.ts existed, this pattern had been silently
 * reimplemented ad hoc at least once — curve-mover.ts's dead
 * `calibrateFullReport` had its own inline `mouseMoveRelative(-127, -127)`
 * ×6 loop, never wired to a real caller, discovered and deleted during the
 * cursor-anchor.ts migration. A future contributor hand-rolling a new slam
 * loop instead of calling `anchorCursor`/`slamToCorner` would reintroduce
 * the exact hazard this module exists to prevent (undocumented, unguarded,
 * un-verified iPad hot-corner risk).
 *
 * Mechanized replacement for ipad-safety-guards.md's old prose instruction
 * ("this path needs its own version of the guard") — a grep, not a promise.
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..');
const ALLOWED_FILES = new Set(['ballistics.ts', 'cursor-anchor.ts']);
// Hardcoded literal magnitude, the shape a copy-pasted/hand-rolled slam
// loop takes. slamToCorner's own parameterised `127 * vec.x` form is
// deliberately NOT matched — it's the one real implementation.
//
// Round 2 Phase 0 / F11: widened from BOTH-axes-±127 to EITHER-axis-±127.
// A hand-rolled slam loop that only reproduces one axis of the pattern
// (e.g. a vertical-only or horizontal-only corner nudge —
// `mouseMoveRelative(-127, 0)`) carries the exact same undocumented,
// unguarded, unverified hot-corner hazard this test exists to catch; the
// original both-axes-literal regex let it through.
const SLAM_SHAPED_PATTERN =
  /mouseMoveRelative\(\s*-?127\s*,\s*[^)]*\)|mouseMoveRelative\(\s*[^,]*,\s*-?127\s*\)/;

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('no fifth copy of the slam-to-corner pattern', () => {
  it('no production .ts file outside ballistics.ts/cursor-anchor.ts hardcodes a mouseMoveRelative(±127, ±127) slam loop', async () => {
    const files = await collectTsFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWED_FILES.has(path.basename(file))) continue;
      const content = await fs.readFile(file, 'utf-8');
      if (SLAM_SHAPED_PATTERN.test(content)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
