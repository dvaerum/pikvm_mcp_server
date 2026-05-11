/**
 * Phase 248 (v0.5.213) — known false-positive locations registry.
 *
 * The iPad's home-screen UI has fixed pixel positions where
 * cursor-template NCC matches exceed the 0.83 minScore floor
 * despite no cursor being present. Phase 247 N=20 + Phase 248
 * visual inspection identified three such positions on the
 * reference iPad (1680×1050 portrait, current wallpaper):
 *
 *   - (852, 941) — pure background between icons row and dock,
 *     wallpaper-gradient FP. Hit 3/20 trials.
 *   - (773, 769) — directly on the TV app icon. Hit 3/20 trials.
 *   - (782, 958) — dock area near page-indicator dots. Hit 2/20.
 *
 * The blocklist is OPT-IN via `FindCursorOptions.fpBlocklist`.
 * Default behaviour is unchanged (no rejection), so production
 * callers see no surprise. Bench scripts and any caller with
 * strong target-region prior can opt in.
 *
 * Future generalization: auto-curated registry. After many
 * sessions, the algorithm could observe its own confident-wrong
 * positions and add them to the blocklist. Out of scope here.
 */

import type { Point } from './client.js';

export interface FpBlocklist {
  centers: Point[];
  /** Reject any template-match position within this many px of any
   *  blocklist center. */
  radius: number;
}

/**
 * Phase 247/248 reference: known FP locations on the bb.vcamp.dk
 * iPad (1680×1050 portrait, default home screen wallpaper).
 *
 * Use radius 50 — wide enough to catch the cluster around each
 * FP center (Phase 247 found (773, 769) ≈ (774, 770) ≈ (772, 770)
 * within ~3 px) without rejecting cursor positions that happen
 * to land near a non-FP icon edge.
 */
export const KNOWN_HOME_SCREEN_FPS_1680x1050: FpBlocklist = {
  centers: [
    { x: 852, y: 941 },
    { x: 773, y: 769 },
    { x: 782, y: 958 },
  ],
  radius: 50,
};

/** Pure helper: is the candidate position within `radius` px of
 *  any blocklist center? */
export function isWithinKnownFp(
  candidate: Point,
  blocklist: FpBlocklist | undefined,
): boolean {
  if (!blocklist) return false;
  for (const fp of blocklist.centers) {
    const dx = candidate.x - fp.x;
    const dy = candidate.y - fp.y;
    if (dx * dx + dy * dy <= blocklist.radius * blocklist.radius) {
      return true;
    }
  }
  return false;
}
