/**
 * Phase 54 — unit tests for the pure two-stage pre-click cursor
 * agreement check.
 *
 * Each test builds a synthetic screenshot containing a single cursor-
 * shaped bright blob, extracts a CursorTemplate from that blob, then
 * calls evaluatePreClickAgreement with various `claimed` cursor
 * positions to exercise:
 *
 *   - Stage A pass (claim is at/near actual cursor; narrow window
 *     finds a confident match).
 *   - Stage A fail + Stage B agree (claim is outside narrow window
 *     but within close-enough distance of the best match).
 *   - Stage A fail + Stage B disagree (claim is far from best match
 *     — algorithm lied).
 *   - Stage B no template match.
 *   - Stage B match below score threshold.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  decodeScreenshot,
  extractCursorTemplateDecoded,
  type CursorTemplate,
  type DecodedScreenshot,
} from '../cursor-detect.js';
import { evaluatePreClickAgreement } from '../click-verify.js';

/** Build a 256×256 dark frame with a single bright 12×12 cursor blob
 *  centered at (cx, cy). */
async function frameWithBlobAt(cx: number, cy: number): Promise<DecodedScreenshot> {
  const w = 256, h = 256;
  const raw = Buffer.alloc(w * h * 3, 30); // dark grey
  for (let y = cy - 6; y < cy + 6; y++) {
    for (let x = cx - 6; x < cx + 6; x++) {
      const idx = (y * w + x) * 3;
      raw[idx] = 240;
      raw[idx + 1] = 240;
      raw[idx + 2] = 240;
    }
  }
  const png = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  return decodeScreenshot(png);
}

async function makeTemplate(cx: number, cy: number): Promise<CursorTemplate> {
  const frame = await frameWithBlobAt(cx, cy);
  return extractCursorTemplateDecoded(frame, { x: cx, y: cy }, 24);
}

describe('evaluatePreClickAgreement', () => {
  it('Stage A passes: claim within narrow window, confident match → agree', async () => {
    const frame = await frameWithBlobAt(100, 100);
    const tmpl = await makeTemplate(100, 100);
    // Claim is at the actual cursor — Stage A finds a 1.0-score match.
    const verdict = evaluatePreClickAgreement(frame, [tmpl], { x: 100, y: 100 }, 0.85);
    expect(verdict.agree).toBe(true);
    expect(verdict.reason).toBe('');
  });

  it('Stage B agree: claim 150 px from actual cursor — outside narrow but inside close-enough', async () => {
    const frame = await frameWithBlobAt(100, 100);
    const tmpl = await makeTemplate(100, 100);
    // Claim at (220, 100): 120 px from cursor — outside narrow=100 but
    // inside close-enough=200 (default). Must override defaults to make
    // the test deterministic against parameter changes.
    const verdict = evaluatePreClickAgreement(
      frame, [tmpl], { x: 220, y: 100 }, 0.85,
      { narrowRadius: 100, closeEnoughDistance: 200 },
    );
    expect(verdict.agree).toBe(true);
  });

  it('Stage B disagree: claim 250 px from actual cursor — beyond close-enough → algorithm lied', async () => {
    const frame = await frameWithBlobAt(100, 100);
    const tmpl = await makeTemplate(100, 100);
    // Claim at (200, 200): hypot(100,100) ≈ 141 px away — but with both
    // radii at 50 / 100, the claim should be flagged as a lie.
    const verdict = evaluatePreClickAgreement(
      frame, [tmpl], { x: 200, y: 200 }, 0.85,
      { narrowRadius: 50, closeEnoughDistance: 100 },
    );
    expect(verdict.agree).toBe(false);
    expect(verdict.reason).toContain('algorithm lied');
    expect(verdict.reason).toContain('200,200');
  });

  it('Stage B disagree: no templates → empty session → "no template match"', async () => {
    const frame = await frameWithBlobAt(100, 100);
    const verdict = evaluatePreClickAgreement(frame, [], { x: 100, y: 100 }, 0.85);
    expect(verdict.agree).toBe(false);
    expect(verdict.reason).toContain('no template match');
  });

  it('Stage B disagree: best match below minScore', async () => {
    // Frame contains the blob, but we use a template captured against a
    // DIFFERENT frame so it scores low.
    const frame = await frameWithBlobAt(100, 100);
    const otherFrame = await frameWithBlobAt(50, 50);
    // Make a template from a DARK region (no cursor) on the other frame —
    // it'll score low against the blob.
    const darkTemplate = extractCursorTemplateDecoded(otherFrame, { x: 200, y: 200 }, 24);
    const verdict = evaluatePreClickAgreement(
      frame, [darkTemplate], { x: 0, y: 0 }, 0.99, // high minScore
    );
    expect(verdict.agree).toBe(false);
    // Either "no template match" (if score≤0 filtered) or "below minScore" — both indicate disagreement.
    expect(verdict.reason).toMatch(/no template match|< 0\.99/);
  });

  it('REGRESSION (Phase 52): Stage A radius default is wide enough for ~150 px Y-residual', async () => {
    // Live failure that motivated Phase 52: cursor at (1295, 535),
    // algorithm claimed (1296, 699) — 164 px Y-off. With the default
    // narrowRadius=200, Stage A must FIND the cursor and return agree
    // even though the claim is 164 px away.
    //
    // findCursorByTemplate uses step=4, so the search grid may not align
    // exactly with the cursor; lower the gating minScore to 0.6 so a
    // slightly offset template-match still passes Stage A. The point of
    // this regression is the radius behaviour, not score sensitivity.
    const frame = await frameWithBlobAt(152, 100);
    const tmpl = await makeTemplate(152, 100);
    // Claim 150 px below the actual cursor — within default radius 200.
    const verdict = evaluatePreClickAgreement(frame, [tmpl], { x: 152, y: 250 }, 0.6);
    expect(verdict.agree).toBe(true);
  });
});
