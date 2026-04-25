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
import { detectMotion } from '../move-to.js';

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
      template,             // Phase 2: template
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
