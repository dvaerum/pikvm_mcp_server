/**
 * Tests for detectMotion's pair-selection — specifically the fallback
 * that kicks in when no pre-cluster is within the expected-start
 * window but we have ≥2 sized clusters elsewhere in the frame. This is
 * the case that was causing real-world failures: the cursor's actual
 * position drifted from our slam-anchor assumption, so the windowed
 * pre-search returned empty even though the diff produced both
 * pre and post clusters.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { decodeScreenshot, extractCursorTemplateDecoded } from '../cursor-detect.js';
import {
  capCorrectionMickeys,
  clampMickeysToScreen,
  detectMotion,
  isOriginProbeMatchPlausible,
  pickNearestPlausibleMatch,
  shouldAbortBlindCorrections,
} from '../move-to.js';
import type { MovePassDiagnostic } from '../move-to.js';

async function makeFrame(width: number, height: number, fill: [number, number, number]): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = fill[0];
    buf[i * 3 + 1] = fill[1];
    buf[i * 3 + 2] = fill[2];
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function stamp(
  base: Buffer,
  cx: number,
  cy: number,
  size: number,
  colour: [number, number, number],
): Promise<Buffer> {
  const decoded = await sharp(base).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(decoded.data);
  const w = decoded.info.width;
  const h = decoded.info.height;
  const half = Math.floor(size / 2);
  for (let y = cy - half; y <= cy + half; y++) {
    if (y < 0 || y >= h) continue;
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || x >= w) continue;
      const i = (y * w + x) * 3;
      data[i] = colour[0];
      data[i + 1] = colour[1];
      data[i + 2] = colour[2];
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe('detectMotion', () => {
  // Cursor moves from (50, 50) to (150, 80). expectedStart matches.
  it('finds a pair when both pre and post clusters fall within their windows', async () => {
    const w = 300, h = 200;
    const wallpaper = [200, 200, 200] as [number, number, number];
    const cursor = [240, 240, 240] as [number, number, number];
    const a = await decodeScreenshot(await stamp(await makeFrame(w, h, wallpaper), 50, 50, 7, cursor));
    const b = await decodeScreenshot(await stamp(await makeFrame(w, h, wallpaper), 150, 80, 7, cursor));

    const r = detectMotion(
      a, b,
      { x: 50, y: 50 },     // expectedStart matches actual
      { x: 150, y: 80 },    // expectedEnd matches actual
      { x: 100, y: 30 },    // commanded mickeys (any non-zero, just for direction)
      120, 600,             // pre/post windows
      false,                // verbose
      8, 90,                // cluster size
      170,                  // brightnessFloor — bright wallpaper, 170 works
    );
    expect(r.pair).not.toBeNull();
    expect(r.reason).toBeNull();
    expect(r.preCandidates).toBeGreaterThanOrEqual(1);
    expect(r.postCandidates).toBeGreaterThanOrEqual(1);
  });

  // REGRESSION: cursor actually moved (50,50)->(150,80) but our
  // expectedStart guess was wildly wrong (e.g., slam mis-anchored
  // somewhere far away). Without the fallback, motion-diff returns null
  // even though the diff has both clusters. WITH the fallback, the pair
  // is recovered because direction matches commanded.
  it('REGRESSION: recovers pair when expectedStart is wrong but ≥2 sized clusters exist', async () => {
    const w = 400, h = 300;
    const wallpaper = [200, 200, 200] as [number, number, number];
    const cursor = [240, 240, 240] as [number, number, number];
    // Cursor truly moves from (50, 50) to (150, 80).
    const a = await decodeScreenshot(await stamp(await makeFrame(w, h, wallpaper), 50, 50, 7, cursor));
    const b = await decodeScreenshot(await stamp(await makeFrame(w, h, wallpaper), 150, 80, 7, cursor));

    // We TELL detectMotion the cursor was supposedly at (350, 250) —
    // far from where it actually was (slam-anchor assumption gone wrong).
    const r = detectMotion(
      a, b,
      { x: 350, y: 250 },   // expectedStart is WRONG
      { x: 150, y: 80 },    // expectedEnd is correct
      { x: 100, y: 30 },    // commanded direction +x +y
      120, 600,
      false,
      8, 90,
      170,
    );
    // Pre-window search would find 0 candidates near (350, 250).
    // The fallback should expand to ALL sized clusters and recover the
    // (50, 50) cluster as pre. Direction validation then accepts the pair.
    expect(r.pair).not.toBeNull();
    // We should also see this in the result: preCandidates reflects the
    // expanded pool size (≥2), not the empty windowed match.
    expect(r.preCandidates).toBeGreaterThanOrEqual(2);
  });

  it('REGRESSION (Phase 1): requireAchromatic accepts gray-cursor pair on colored background', async () => {
    // Cursor is gray (240,240,240) over a uniformly-colored orange backdrop.
    // The diff produces gray cursor clusters whose mean RGB is ~achromatic.
    // requireAchromatic must NOT reject this — the failure mode we are
    // protecting against is killing the cursor, not just colored widgets.
    // brightnessFloor=0 here so the colored-wallpaper diff isn't suppressed
    // by per-pixel brightness; we're isolating the achromatic-filter test.
    const w = 400, h = 300;
    const wallpaper = [180, 100, 60] as [number, number, number]; // orange
    const cursor = [240, 240, 240] as [number, number, number];
    const a = await decodeScreenshot(await stamp(await makeFrame(w, h, wallpaper), 50, 50, 7, cursor));
    const b = await decodeScreenshot(await stamp(await makeFrame(w, h, wallpaper), 150, 80, 7, cursor));

    const r = detectMotion(
      a, b,
      { x: 50, y: 50 },
      { x: 150, y: 80 },
      { x: 100, y: 30 },
      120, 600,
      false,
      8, 90,
      0,                    // brightnessFloor disabled
      true,                 // requireAchromatic
    );
    expect(r.pair).not.toBeNull();
  });

  it('Phase 1: requireAchromatic rejects a single colored-widget pair', async () => {
    // Build a frame pair where the ONLY change is a colored (orange) blob
    // moving — no cursor at all. With requireAchromatic on, this must
    // return null because the only candidate cluster's mean colour is
    // chromatic (high R, low G/B). brightnessFloor=0 to focus the test
    // on the achromatic-filter path.
    const w = 400, h = 300;
    const wallpaper = [200, 200, 200] as [number, number, number]; // gray bg
    const widgetA = [240, 80, 40] as [number, number, number];     // orange
    const widgetB = [240, 80, 40] as [number, number, number];     // same orange
    const a = await decodeScreenshot(await stamp(await makeFrame(w, h, wallpaper), 60, 60, 7, widgetA));
    const b = await decodeScreenshot(await stamp(await makeFrame(w, h, wallpaper), 160, 90, 7, widgetB));

    // Without requireAchromatic: this colored-blob pair WOULD be picked
    // as a valid pair (same shape, right direction, valid magnitude).
    const baseline = detectMotion(
      a, b,
      { x: 60, y: 60 },
      { x: 160, y: 90 },
      { x: 100, y: 30 },
      120, 600,
      false,
      8, 90,
      0,
    );
    expect(baseline.pair).not.toBeNull();

    // With requireAchromatic on: filter rejects the colored cluster, no
    // pair survives, motion-diff returns null.
    const filtered = detectMotion(
      a, b,
      { x: 60, y: 60 },
      { x: 160, y: 90 },
      { x: 100, y: 30 },
      120, 600,
      false,
      8, 90,
      0,
      true,                 // requireAchromatic
    );
    expect(filtered.pair).toBeNull();
  });

  it('Phase 2: template re-ranks pair selection when geometry is ambiguous', async () => {
    // Two candidate pairs in the same diff:
    //   Pair A (widget): pre at (50,50), post at (150,80) — colored orange.
    //                    Geometrically AT expectedStart/End so geometry wins.
    //   Pair B (cursor): pre at (60,100), post at (160,130) — gray cursor.
    //                    Both ~51 px offset from expected positions
    //                    (within the 120 px preWindow / 600 px postWindow).
    //
    // Without template: pair A wins (lower dist to expected positions).
    // With a gray-cursor template: pair B wins (post-cluster region matches
    //   the template; pair A's orange post-region scores low).
    const w = 400, h = 250;
    const wallpaper = [200, 200, 200] as [number, number, number]; // gray bg
    const cursor = [240, 240, 240] as [number, number, number];     // gray cursor
    const orange = [240, 80, 40] as [number, number, number];

    // Frame A: orange widget at (50,50), gray cursor at (60,100).
    let aBuf = await makeFrame(w, h, wallpaper);
    aBuf = await stamp(aBuf, 50, 50, 7, orange);
    aBuf = await stamp(aBuf, 60, 100, 7, cursor);
    // Frame B: orange widget at (150,80), gray cursor at (160,130).
    let bBuf = await makeFrame(w, h, wallpaper);
    bBuf = await stamp(bBuf, 150, 80, 7, orange);
    bBuf = await stamp(bBuf, 160, 130, 7, cursor);

    const a = await decodeScreenshot(aBuf);
    const b = await decodeScreenshot(bBuf);

    // Build a gray-cursor template from frame B's known cursor location.
    const template = extractCursorTemplateDecoded(b, { x: 160, y: 130 }, 24);

    // Baseline (no template): pair A (orange widget) wins by geometry.
    const baseline = detectMotion(
      a, b,
      { x: 50, y: 50 },     // expectedStart matches widget pre
      { x: 150, y: 80 },    // expectedEnd matches widget post
      { x: 100, y: 30 },
      120, 600,
      false,
      8, 90,
      0,
      false,                // requireAchromatic OFF — isolate template test
    );
    expect(baseline.pair).not.toBeNull();
    // Baseline should pick the geometrically-closer (orange) pair.
    expect(Math.abs(baseline.pair!.post.centroidX - 150)).toBeLessThan(10);
    expect(Math.abs(baseline.pair!.post.centroidY - 80)).toBeLessThan(10);

    // With template: pair B (gray cursor) should win because its post-cluster
    // region matches the template, even though it's geometrically farther.
    const withTemplate = detectMotion(
      a, b,
      { x: 50, y: 50 },
      { x: 150, y: 80 },
      { x: 100, y: 30 },
      120, 600,
      false,
      8, 90,
      0,
      false,
      [template],           // Phase 2 + 3: template set
    );
    expect(withTemplate.pair).not.toBeNull();
    // With template, the cursor pair (post at y≈130) should win.
    expect(Math.abs(withTemplate.pair!.post.centroidY - 130)).toBeLessThan(10);
  });

  it('still returns null when commanded direction is ~perpendicular to actual cluster pair', async () => {
    const w = 400, h = 300;
    const wallpaper = [200, 200, 200] as [number, number, number];
    const cursor = [240, 240, 240] as [number, number, number];
    // Real motion: cursor diagonal (50,50) -> (150,80).
    const a = await decodeScreenshot(await stamp(await makeFrame(w, h, wallpaper), 50, 50, 7, cursor));
    const b = await decodeScreenshot(await stamp(await makeFrame(w, h, wallpaper), 150, 80, 7, cursor));

    // We claim we commanded purely -y (no x component). The actual pair
    // is (~+100, ~+30) or its inverse (~-100, ~-30). Both are far enough
    // off the y axis that the cosine-0.7 (~45°) direction filter rejects.
    const r = detectMotion(
      a, b,
      { x: 350, y: 250 },
      { x: 350, y: 200 },    // expectedEnd offset purely -y from start
      { x: 0, y: -50 },      // commanded purely -y
      120, 600,
      false,
      8, 90,
      170,
    );
    expect(r.pair).toBeNull();
    expect(r.reason).toMatch(/no pair passed|no post candidate|no pre candidate/i);
  });
});

function diag(pass: number, mode: MovePassDiagnostic['mode']): MovePassDiagnostic {
  return {
    pass,
    mode,
    detectedAt: { x: 0, y: 0 },
    residualPx: 100,
    ratioUsed: { x: 1, y: 1 },
    reason: null,
    linearPhase: false,
  };
}

describe('pickNearestPlausibleMatch (Phase 11 multi-template ranking)', () => {
  // When multi-template fallback returns multiple plausible cursor
  // positions across a screenshot (each template's NCC peak is at a
  // different spot, with several scoring high enough to look like the
  // cursor), naïve "highest-score-wins" picks a stable false positive
  // over the real cursor. The correction-pass case has a strong prior:
  // the cursor was just at `prevPos` and moved a small predictable
  // amount. Prefer matches NEAR that prior over far high-scoring FPs.
  type M = { position: { x: number; y: number }; score: number };

  const make = (x: number, y: number, s: number): M => ({ position: { x, y }, score: s });

  it('prefers a closer-to-hint match over a far higher-scoring one', () => {
    const matches: M[] = [
      make(800, 700, 0.94),  // far, very high score (FP at UI element)
      make(1057, 837, 0.91),  // near hint, slightly lower score
    ];
    const r = pickNearestPlausibleMatch(matches, { x: 1027, y: 825 }, 100);
    expect(r).not.toBeNull();
    expect(r!.position.x).toBe(1057);
    expect(r!.position.y).toBe(837);
  });

  it('falls back to highest score when nothing is within hint radius', () => {
    const matches: M[] = [
      make(800, 700, 0.94),
      make(50, 50, 0.91),
    ];
    const r = pickNearestPlausibleMatch(matches, { x: 1027, y: 825 }, 100);
    expect(r).not.toBeNull();
    expect(r!.position.x).toBe(800);
    expect(r!.score).toBe(0.94);
  });

  it('returns null when input is empty', () => {
    expect(pickNearestPlausibleMatch([], { x: 100, y: 100 }, 50)).toBeNull();
  });

  it('returns highest score when no hint is provided', () => {
    const matches: M[] = [make(0, 0, 0.5), make(100, 100, 0.95), make(200, 200, 0.7)];
    const r = pickNearestPlausibleMatch(matches, null, 100);
    expect(r!.score).toBe(0.95);
  });

  it('chooses the highest-score match within radius (not the closest one)', () => {
    // Both within 100 px of hint (0,0): (20,20) is ~28 px away,
    // (50,50) is ~71 px away. Higher-scoring one wins.
    const matches: M[] = [make(20, 20, 0.85), make(50, 50, 0.93)];
    const r = pickNearestPlausibleMatch(matches, { x: 0, y: 0 }, 100);
    expect(r!.score).toBe(0.93);
  });
});

describe('isOriginProbeMatchPlausible (Phase 10 origin verification)', () => {
  // After template-match claims the cursor is at `claimed`, we emit a
  // small +X probe and look at the post-cluster centroid. The post
  // cluster should be near `claimed + (probe*ratio, 0)`. If the
  // observed post is wildly elsewhere, the template-match origin was
  // a false positive.
  const tolerance = 40;

  it('accepts a post-cluster near the predicted landing', () => {
    const r = isOriginProbeMatchPlausible(
      { x: 100, y: 200 },           // claimed origin
      { x: 132, y: 202 },           // observed post
      { x: 30, y: 0 },              // probe offset (+30 px X)
      tolerance,
    );
    expect(r).toBe(true);
  });

  it('rejects a post-cluster far from the predicted landing', () => {
    const r = isOriginProbeMatchPlausible(
      { x: 100, y: 200 },
      { x: 800, y: 50 },             // observed post is far away
      { x: 30, y: 0 },
      tolerance,
    );
    expect(r).toBe(false);
  });

  it('rejects when observed post is at the claimed position (cursor did not move)', () => {
    // Cursor "didn't move" relative to the claimed origin → claim is wrong.
    const r = isOriginProbeMatchPlausible(
      { x: 100, y: 200 },
      { x: 102, y: 200 },
      { x: 30, y: 0 },
      tolerance,
    );
    expect(r).toBe(false);
  });

  it('handles negative probe direction', () => {
    const r = isOriginProbeMatchPlausible(
      { x: 200, y: 200 },
      { x: 175, y: 200 },           // moved -25 X
      { x: -30, y: 0 },             // probe was -30 px X
      tolerance,
    );
    expect(r).toBe(true);
  });
});

describe('capCorrectionMickeys (Phase 9 magnitude cap)', () => {
  it('returns inputs unchanged when both axes are within cap', () => {
    const r = capCorrectionMickeys(20, 30, 50);
    expect(r.x).toBe(20);
    expect(r.y).toBe(30);
  });

  it('scales both axes proportionally when X exceeds cap', () => {
    // X=200, Y=50, cap=100 → scale = 100/200 = 0.5; result (100, 25)
    const r = capCorrectionMickeys(200, 50, 100);
    expect(r.x).toBe(100);
    expect(r.y).toBe(25);
  });

  it('scales both axes proportionally when Y exceeds cap', () => {
    // X=20, Y=200, cap=80 → scale = 80/200 = 0.4; result (8, 80)
    const r = capCorrectionMickeys(20, 200, 80);
    expect(r.x).toBe(8);
    expect(r.y).toBe(80);
  });

  it('preserves sign when scaling', () => {
    const r = capCorrectionMickeys(-200, 50, 100);
    expect(r.x).toBe(-100);
    expect(r.y).toBe(25);
  });

  it('passes zero through (no division by zero)', () => {
    const r = capCorrectionMickeys(0, 0, 100);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
});

describe('clampMickeysToScreen (Phase 6 edge guard)', () => {
  const bounds = { width: 1920, height: 1080 };

  it('passes through when projected landing is well within screen', () => {
    const r = clampMickeysToScreen({ x: 500, y: 500 }, 100, 50, 1.0, 1.0, bounds);
    expect(r.x).toBe(100);
    expect(r.y).toBe(50);
  });

  it('caps positive-X mickeys to keep cursor inside the right edge', () => {
    // Origin near right edge, large +X plan would push cursor off-screen.
    const r = clampMickeysToScreen({ x: 1900, y: 500 }, 200, 0, 1.0, 1.0, bounds);
    // projectedX = 1900 + 200*1.0 = 2100, off-screen by 200px
    // cap so projectedX = 1920 - 20 (margin) = 1900 → x = 0 (no movement allowed)
    expect(r.x).toBeLessThanOrEqual(0);
    expect(r.y).toBe(0);
  });

  it('caps negative-Y mickeys to keep cursor inside the top edge', () => {
    // Origin near top, large -Y plan would push cursor above the screen.
    const r = clampMickeysToScreen({ x: 500, y: 30 }, 0, -200, 1.0, 1.0, bounds);
    // projectedY = 30 - 200*1.0 = -170, above screen
    // cap so projectedY = 20 (margin) → y = (20-30)/1.0 = -10
    expect(r.y).toBeGreaterThanOrEqual(-15);
    expect(r.x).toBe(0);
  });

  it('preserves direction (sign) when clamping', () => {
    const r = clampMickeysToScreen({ x: 1900, y: 500 }, 500, 100, 2.0, 1.0, bounds);
    // X would project to 1900 + 1000 = 2900; clamp keeps sign positive but
    // reduces magnitude.
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBe(100); // Y unaffected
  });

  it('handles ratio 0 / NaN gracefully (returns input)', () => {
    const r = clampMickeysToScreen({ x: 500, y: 500 }, 100, 50, 0, 0, bounds);
    expect(r.x).toBe(100);
    expect(r.y).toBe(50);
  });
});

describe('shouldAbortBlindCorrections (Phase 4 circuit breaker)', () => {
  it('returns false on the first predicted pass (single failure can be recovered)', () => {
    const ds = [diag(0, 'motion'), diag(1, 'predicted')];
    expect(shouldAbortBlindCorrections(ds)).toBe(false);
  });

  it('returns true after 2 consecutive predicted passes', () => {
    const ds = [diag(0, 'motion'), diag(1, 'predicted'), diag(2, 'predicted')];
    expect(shouldAbortBlindCorrections(ds)).toBe(true);
  });

  it('a template-recovered pass between two predicted passes resets the streak', () => {
    const ds = [
      diag(0, 'motion'),
      diag(1, 'predicted'),
      diag(2, 'template'),
      diag(3, 'predicted'),
    ];
    expect(shouldAbortBlindCorrections(ds)).toBe(false);
  });

  it('returns false on an empty diagnostic list', () => {
    expect(shouldAbortBlindCorrections([])).toBe(false);
  });

  it('returns false if last pass is verified (motion or template)', () => {
    const ds = [diag(0, 'predicted'), diag(1, 'predicted'), diag(2, 'motion')];
    expect(shouldAbortBlindCorrections(ds)).toBe(false);
  });
});
