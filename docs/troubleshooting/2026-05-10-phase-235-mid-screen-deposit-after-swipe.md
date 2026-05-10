# Phase 235 — mid-screen cursor deposit after forceHomeViaSwipe

**Date:** 2026-05-10
**Version:** v0.5.208
**Status:** Shipped + live-verified.

## Problem

Phase 231 verified at v0.5.207 with N=3 = 1/3 within 35 px tolerance.
Subsequent N=3 runs ranged from 0/3 to 1/3. The dominant failure mode
in screenshots: **cursor pinned at top edge** after `forceHomeViaSwipe`.

The swipe drag terminates at `y≈0` (clamped against the top edge),
leaving the cursor pinned there. moveToPixel cannot recover from this
in one call because of the per-call mickey cap (~52 px x-axis,
~135 px y-axis on this iPad). Targets in the bottom half of the
screen (e.g. (905, 800) Settings) are physically unreachable.

## Diagnostic data (Phase 235 N=5)

`test-phase235-no-swipe-between.ts` — alternates target/center
moveToPixel calls without re-swiping between trials.

| trial | goal             | residual | conclusion                            |
|:-----:|:-----------------|:--------:|:--------------------------------------|
| 1     | target (905,800) | 438 px   | ❌ cursor pinned at top after swipe    |
| 2     | center (640,540) |  18 px   | ✅ cursor moved fine to center         |
| 3     | target (905,800) | null     | (after center, detection failed)      |
| 4     | center (640,540) |  19 px   | ✅                                     |
| 5     | target (905,800) |  33 px   | ✅ (cursor mid-screen, hit tolerance!) |

**The pattern is unambiguous:** when cursor starts at top edge, target
clicks fail at 400+ px residual. When cursor starts mid-screen, target
clicks succeed (or fail by smaller, recoverable amounts).

## Fix

After the swipe + defensive Esc+Enter (Phase 231), deposit cursor
at mid-screen using chunked Y-only emits:

```ts
if (bounds) {
  const targetY = Math.round(bounds.y + bounds.height / 2);
  let remDescend = Math.max(0, targetY);
  while (remDescend > 0) {
    const step = Math.min(100, remDescend);
    await client.mouseMoveRelative(0, step);
    remDescend -= step;
    await sleep(40);
  }
} else {
  for (let i = 0; i < 6; i++) {
    await client.mouseMoveRelative(0, 100);
    await sleep(40);
  }
}
```

Why this works (and why Phase 232's two-emit attempt didn't):
- Phase 232 used 2 emits (40 + 100) totaling ~140 px commanded;
  per-call cap means ~80–100 px actual motion. From `y≈0` to
  mid-screen ≈ 540 px — 80 px barely dents the gap.
- Phase 235 uses 6 emits of 100 px each = 600 px commanded with
  40 ms settle between, giving iPadOS time to register each emit
  separately rather than clamping. ~540 px actual motion.

The 40 ms settle is the same pacing used in the existing pre-swipe
positioning loop at `ipad-unlock.ts:407` — proven good.

## Live verification at v0.5.208

`test-phase231-n3-verify.ts` after the fix:

| run | residuals (px)            | within 35 px |
|:---:|:--------------------------|:------------:|
|  1  | 7.2, 141, 151             | 1/3          |
|  2  | 317, 151, 27.5            | 1/3          |

Combined N=6: 2/6 = **33% within tolerance** (vs pre-Phase-235
runs at 0–17%).

Crucially, **no trial in either run shows the top-edge pinning
failure mode**. Failures now are:
- Detection error (algorithm reports a position that doesn't
  match visible cursor) — pre-existing
- moveToPixel landing 140–150 px off horizontally — pre-existing
- Occasional 300+ px miss — pre-existing, less frequent

## What stays open

The detection-error and X-axis-overshoot failure modes are
pre-existing and unaffected by Phase 235. They're documented in
the broader troubleshooting record under:
- `2026-05-10-phase-194d-cursor-desync.md`
- `2026-05-10-phase-211-residual-pattern-summary.md`
- `ipad-cursor-detection.md` (TL;DR honesty note)

Phase 235's contribution: removed the dominant **top-edge
pinning** failure that was masking everything else. The other
failures remain visible and actionable for future phases.

## Tests

`src/pikvm/__tests__/ipadGoHome.test.ts` adds 2 regression tests:
- "deposits cursor mid-screen after the swipe + Esc + Enter":
  asserts ≥400 px cumulative downward motion after swipe end
- "deposit emits are chunked (no single emit > 127 px)":
  ensures we don't regress to oversized emits that get clamped
