/**
 * Phase 318 — isLikelyLockScreen calibration tests.
 *
 * Pins the discriminator threshold against captured frames:
 *   - Home screen: dock has app icons → high stddev (~68)
 *   - Lock screen: dock area is just home-indicator + wallpaper → low stddev (~43)
 *
 * Default threshold (55) sits cleanly between the two clusters.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { isLikelyLockScreen } from '../ipad-unlock.js';

const HOME_FRAMES = [
  'data/v241-settings/2026-05-13_08-35-59/t1-pre.jpg',
  'data/v241-settings/2026-05-13_08-35-59/t3-pre.jpg',
  'data/v240-click-diag/2026-05-13_08-21-04/t1-baseline-150-pre.jpg',
];

const LOCK_FRAMES = [
  'data/v241-settings/2026-05-13_08-35-59/t4-pre.jpg',
  'data/v241-settings/2026-05-13_08-35-59/t5-pre.jpg',
  'data/v241-short/2026-05-13_09-20-13/t1-pre.jpg',
];

describe('isLikelyLockScreen', () => {
  for (const p of HOME_FRAMES) {
    it(`reports home screen for ${path.basename(p)}`, async () => {
      const buf = await fs.readFile(path.resolve(p)).catch(() => null);
      if (!buf) {
        // Skip if the calibration frame isn't available — these are
        // captured during live benches and may not be in the repo.
        return;
      }
      expect(await isLikelyLockScreen(buf)).toBe(false);
    });
  }
  for (const p of LOCK_FRAMES) {
    it(`reports lock screen for ${path.basename(p)}`, async () => {
      const buf = await fs.readFile(path.resolve(p)).catch(() => null);
      if (!buf) return;
      expect(await isLikelyLockScreen(buf)).toBe(true);
    });
  }
});
