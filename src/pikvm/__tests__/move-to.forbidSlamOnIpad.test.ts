/**
 * Phase 32: explicit-strategy slam guard for iPad-portrait targets.
 *
 * Background: `forbidSlamFallback` (Phase 11+) only protects the
 * auto-fallback path inside detect-then-move. When a caller explicitly
 * passes `strategy='slam-then-move'` on an iPad-portrait target, the slam
 * still runs and triggers iPadOS hot-corner re-lock. This was live-verified
 * 2026-04-26 — a single explicit slam-then-move locked the iPad mid-session.
 *
 * `forbidSlamOnIpad` (default true) detects iPad bounds before the slam
 * and refuses with a clear error. Caller must opt out (forbidSlamOnIpad=false)
 * to allow the dangerous behaviour.
 *
 * The guard logic itself now lives in cursor-anchor.ts's `bounds-guard`
 * AnchorGuard (moveToPixel's `forbidSlamOnIpad=false` maps to
 * `allowOnUndetermined: true` — see its doc comment for why that's a
 * throw-only toggle, not a computation toggle). This file stays as the
 * end-to-end pin through the real moveToPixel path; see
 * cursor-anchor.test.ts for direct unit coverage of the guard combinations.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { moveToPixel } from '../move-to.js';
import { clearOrientationCache } from '../orientation.js';
import type { PiKVMClient, ScreenResolution } from '../client.js';

/** A 1920×1080 frame that LOOKS like an iPad in portrait letterbox:
 *  black bars on left/right, bright content in the middle. The bounds
 *  detector will read this as portrait orientation. */
async function makeIpadPortraitFrame(): Promise<Buffer> {
  const w = 1920;
  const h = 1080;
  const data = Buffer.alloc(w * h * 3, 0);
  // iPad letterbox: black 0..624, content 625..1295, black 1296..1919.
  const ipadX0 = 625;
  const ipadX1 = 1295;
  for (let y = 0; y < h; y++) {
    for (let x = ipadX0; x <= ipadX1; x++) {
      const i = (y * w + x) * 3;
      // Bright grey content well above the brightness floor.
      data[i] = 200;
      data[i + 1] = 200;
      data[i + 2] = 200;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

class IpadPortraitClient {
  resolution: ScreenResolution = { width: 1920, height: 1080 };
  slamCalls = 0;

  async getResolution(): Promise<ScreenResolution> {
    return this.resolution;
  }
  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    const buf = await makeIpadPortraitFrame();
    return { buffer: buf, screenshotWidth: 1920, screenshotHeight: 1080 };
  }
  async mouseMoveRelative(dx: number, _dy: number): Promise<void> {
    // Heuristic: a slam emits many large negative deltas in a row.
    if (dx <= -100) this.slamCalls++;
  }
}

describe('moveToPixel forbidSlamOnIpad', () => {
  it('refuses explicit slam-then-move when iPad-portrait letterbox is detected', async () => {
    clearOrientationCache();
    const client = new IpadPortraitClient();
    await expect(
      moveToPixel(client as unknown as PiKVMClient, { x: 1000, y: 800 }, {
        strategy: 'slam-then-move',
        warmupMickeys: 0,
        calibrationProbeMickeys: 0,
      }),
    ).rejects.toThrow(/iPad-portrait letterbox detected|hot-corner gesture/i);
    expect(client.slamCalls).toBe(0);
  }, 30000);

  it('allows slam-then-move on iPad when forbidSlamOnIpad=false (explicit opt-out)', async () => {
    clearOrientationCache();
    const client = new IpadPortraitClient();
    // No throw expected — caller has explicitly opted out of the safety guard.
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 1000, y: 800 }, {
      strategy: 'slam-then-move',
      forbidSlamOnIpad: false,
      warmupMickeys: 0,
      calibrationProbeMickeys: 0,
      postMoveSettleMs: 0,
    });
    expect(result.strategy).toBe('slam-then-move');
    expect(client.slamCalls).toBeGreaterThan(0);
  }, 30000);

  // Phase 32a: fail-safe when bounds detection can't determine the target.
  it('refuses slam-then-move when bounds detection fails (target type unknown)', async () => {
    clearOrientationCache();
    // All-black frame: bounds detector finds no content → returns null →
    // we have no idea if this is iPad-portrait or something else. The
    // strengthened guard refuses by default rather than risk a hot-corner
    // lock if the unknown target turns out to be iPad-dark-mode.
    class BlackFrameClient {
      resolution: ScreenResolution = { width: 1920, height: 1080 };
      slamCalls = 0;
      async getResolution() { return this.resolution; }
      async screenshot() {
        const buf = await sharp(
          Buffer.alloc(1920 * 1080 * 3, 0),
          { raw: { width: 1920, height: 1080, channels: 3 } },
        ).jpeg().toBuffer();
        return { buffer: buf, screenshotWidth: 1920, screenshotHeight: 1080 };
      }
      async mouseMoveRelative(dx: number, _dy: number) {
        if (dx <= -100) this.slamCalls++;
      }
    }
    const client = new BlackFrameClient();
    await expect(
      moveToPixel(client as unknown as PiKVMClient, { x: 1000, y: 800 }, {
        strategy: 'slam-then-move',
        warmupMickeys: 0,
        calibrationProbeMickeys: 0,
      }),
    ).rejects.toThrow(/target type undetermined|hot-corner|iPad/i);
    expect(client.slamCalls).toBe(0);
  }, 30000);

  // Desktop full-frame degrade path: `pikvm_mouse_click_at` passes
  // forbidSlamOnIpad=false in absolute/desktop mode. This must let a blank/
  // uniform frame (bounds detection fails → null) slam anyway instead of the
  // Phase-32 false-abort — the guard only exists to dodge the iPadOS hot-corner
  // re-lock, which cannot happen on a desktop. Complements the default-true
  // "refuses when bounds fail" case above.
  it('allows slam-then-move when bounds detection fails but caller opted out (desktop mode)', async () => {
    clearOrientationCache();
    class BlackFrameClient {
      resolution: ScreenResolution = { width: 1920, height: 1080 };
      slamCalls = 0;
      async getResolution() { return this.resolution; }
      async screenshot() {
        const buf = await sharp(
          Buffer.alloc(1920 * 1080 * 3, 0),
          { raw: { width: 1920, height: 1080, channels: 3 } },
        ).jpeg().toBuffer();
        return { buffer: buf, screenshotWidth: 1920, screenshotHeight: 1080 };
      }
      async mouseMoveRelative(dx: number, _dy: number) {
        if (dx <= -100) this.slamCalls++;
      }
    }
    const client = new BlackFrameClient();
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 1000, y: 800 }, {
      strategy: 'slam-then-move',
      forbidSlamOnIpad: false, // what click_at passes when mouseAbsoluteMode===true
      warmupMickeys: 0,
      calibrationProbeMickeys: 0,
      postMoveSettleMs: 0,
    });
    expect(result.strategy).toBe('slam-then-move');
    expect(client.slamCalls).toBeGreaterThan(0);
  }, 30000);

  // Phase 32a: when caller explicitly passes slamOriginPx, the guard yields
  // — the caller has decided where to slam to and is taking responsibility.
  it('allows slam-then-move when caller explicitly passes slamOriginPx', async () => {
    clearOrientationCache();
    class BlackFrameClient {
      resolution: ScreenResolution = { width: 1920, height: 1080 };
      slamCalls = 0;
      async getResolution() { return this.resolution; }
      async screenshot() {
        const buf = await sharp(
          Buffer.alloc(1920 * 1080 * 3, 0),
          { raw: { width: 1920, height: 1080, channels: 3 } },
        ).jpeg().toBuffer();
        return { buffer: buf, screenshotWidth: 1920, screenshotHeight: 1080 };
      }
      async mouseMoveRelative(dx: number, _dy: number) {
        if (dx <= -100) this.slamCalls++;
      }
    }
    const client = new BlackFrameClient();
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 1000, y: 800 }, {
      strategy: 'slam-then-move',
      slamOriginPx: { x: 50, y: 50 },
      warmupMickeys: 0,
      calibrationProbeMickeys: 0,
      postMoveSettleMs: 0,
    });
    expect(result.strategy).toBe('slam-then-move');
    expect(client.slamCalls).toBeGreaterThan(0);
  }, 30000);
});

/**
 * F8 (Round 2 Phase 1): pikvm_mouse_move_to's index.ts handler previously
 * ALWAYS constructed a slamOriginPx object (defaulting to {x:625,y:65}) even
 * when the caller supplied neither slamOriginX nor slamOriginY — so
 * `callerProvidedOrigin` (cursor-anchor.ts's bounds-guard) was structurally
 * always true through this call site, meaning the guard could NEVER refuse
 * a slam requested through pikvm_mouse_move_to, regardless of what bounds
 * detection found. Live-verified 2026-04-26's lock incident went through
 * click_at (which never builds slamOriginPx), not move_to — so this gap sat
 * open the entire time Layers 1-3 existed, never exercised through this tool.
 *
 * `buildSlamOriginPx` below mirrors index.ts's ACTUAL arg-parsing (fixed
 * version): only construct an origin when the caller supplied at least one
 * coordinate. The paired negative control proves the OLD (buggy) shape was
 * genuinely unsafe on the exact same frame.
 */
describe('handler-shaped slamOriginPx construction (index.ts pikvm_mouse_move_to)', () => {
  /** Mirrors index.ts's fixed handler logic exactly. */
  function buildSlamOriginPx(args: { slamOriginX?: number; slamOriginY?: number }): { x: number; y: number } | undefined {
    const sx = args.slamOriginX;
    const sy = args.slamOriginY;
    return sx !== undefined || sy !== undefined ? { x: sx ?? 625, y: sy ?? 65 } : undefined;
  }

  /** The OLD (buggy, pre-F8) handler logic — always builds an origin. */
  function buildSlamOriginPxOldBuggy(args: { slamOriginX?: number; slamOriginY?: number }): { x: number; y: number } {
    return { x: args.slamOriginX ?? 625, y: args.slamOriginY ?? 65 };
  }

  it('F8 fix: no slamOriginX/Y supplied ⇒ the Layer-3 guard refuses on a portrait-letterbox frame', async () => {
    clearOrientationCache();
    const client = new IpadPortraitClient();
    const slamOriginPx = buildSlamOriginPx({}); // no args supplied, matching a bare pikvm_mouse_move_to call
    expect(slamOriginPx).toBeUndefined();
    await expect(
      moveToPixel(client as unknown as PiKVMClient, { x: 1000, y: 800 }, {
        strategy: 'slam-then-move',
        slamOriginPx,
        warmupMickeys: 0,
        calibrationProbeMickeys: 0,
      }),
    ).rejects.toThrow(/iPad-portrait letterbox detected|hot-corner gesture/i);
    expect(client.slamCalls).toBe(0);
  }, 30000);

  it('negative control: the OLD unconditional-origin shape defeats the guard on the SAME frame', async () => {
    clearOrientationCache();
    const client = new IpadPortraitClient();
    const slamOriginPx = buildSlamOriginPxOldBuggy({}); // the pre-F8 behavior: always {x:625,y:65}
    expect(slamOriginPx).toEqual({ x: 625, y: 65 });
    // No throw — this is the exact gap F8 closes: the guard sees
    // callerProvidedOrigin=true unconditionally and yields.
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 1000, y: 800 }, {
      strategy: 'slam-then-move',
      slamOriginPx,
      warmupMickeys: 0,
      calibrationProbeMickeys: 0,
      postMoveSettleMs: 0,
    });
    expect(result.strategy).toBe('slam-then-move');
    expect(client.slamCalls).toBeGreaterThan(0);
  }, 30000);

  it('explicit slamOriginX/Y still opts out of the guard as documented (unchanged behavior)', async () => {
    clearOrientationCache();
    const client = new IpadPortraitClient();
    const slamOriginPx = buildSlamOriginPx({ slamOriginX: 50, slamOriginY: 50 });
    expect(slamOriginPx).toEqual({ x: 50, y: 50 });
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 1000, y: 800 }, {
      strategy: 'slam-then-move',
      slamOriginPx,
      warmupMickeys: 0,
      calibrationProbeMickeys: 0,
      postMoveSettleMs: 0,
    });
    expect(result.strategy).toBe('slam-then-move');
    expect(client.slamCalls).toBeGreaterThan(0);
  }, 30000);
});

/**
 * F8 follow-up (live-gate finding, PR #77, georgs-mac-mini 2026-08-25):
 * handle_pikvm_mouse_move_to never threaded forbidSlamOnIpad into
 * moveToPixel's options at all — only forbidSlamFallback was. Since the
 * bounds-guard computes `allowOnUndetermined: options.forbidSlamOnIpad
 * === false`, an always-undefined value can never satisfy that — so on a
 * DESKTOP/absolute target (policy.forbidSlamOnIpad === false) where bounds
 * detection fails (target type undetermined), the tool incorrectly
 * refused a slam that should have been allowed. Confirmed live: spawning
 * with --target desktop and running a no-origin slam-then-move still hit
 * the iPad-letterbox refusal. Fails closed (over-conservative, not
 * unsafe), but the tool's own promised desktop-mode behavior was unmet.
 */
describe('handler-shaped forbidSlamOnIpad wiring (index.ts pikvm_mouse_move_to)', () => {
  class BlackFrameClient {
    resolution: ScreenResolution = { width: 1920, height: 1080 };
    slamCalls = 0;
    async getResolution() { return this.resolution; }
    async screenshot() {
      const buf = await sharp(
        Buffer.alloc(1920 * 1080 * 3, 0),
        { raw: { width: 1920, height: 1080, channels: 3 } },
      ).jpeg().toBuffer();
      return { buffer: buf, screenshotWidth: 1920, screenshotHeight: 1080 };
    }
    async mouseMoveRelative(dx: number, _dy: number) {
      if (dx <= -100) this.slamCalls++;
    }
  }

  it('negative control: NOT threading forbidSlamOnIpad refuses even in desktop mode (target type undetermined)', async () => {
    clearOrientationCache();
    const client = new BlackFrameClient();
    // The pre-follow-up bug: forbidSlamOnIpad simply never passed, so it's
    // always undefined regardless of policy — desktop mode couldn't disarm it.
    await expect(
      moveToPixel(client as unknown as PiKVMClient, { x: 1000, y: 800 }, {
        strategy: 'slam-then-move',
        warmupMickeys: 0,
        calibrationProbeMickeys: 0,
      }),
    ).rejects.toThrow(/target type undetermined|hot-corner|iPad/i);
    expect(client.slamCalls).toBe(0);
  }, 30000);

  it('follow-up fix: forbidSlamOnIpad: policy.forbidSlamOnIpad (false on desktop) allows the slam through', async () => {
    clearOrientationCache();
    const client = new BlackFrameClient();
    // Mirrors HidPolicy.forbidSlamOnIpad for a desktop/absolute target: !mouseAbsolute === false.
    const desktopForbidSlamOnIpad = false;
    const result = await moveToPixel(client as unknown as PiKVMClient, { x: 1000, y: 800 }, {
      strategy: 'slam-then-move',
      forbidSlamOnIpad: desktopForbidSlamOnIpad,
      warmupMickeys: 0,
      calibrationProbeMickeys: 0,
      postMoveSettleMs: 0,
    });
    expect(result.strategy).toBe('slam-then-move');
    expect(client.slamCalls).toBeGreaterThan(0);
  }, 30000);
});
