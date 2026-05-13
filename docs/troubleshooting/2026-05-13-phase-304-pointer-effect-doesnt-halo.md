# Phase 304 — pointer-effect doesn't create a detectable halo

**Date:** 2026-05-13
**Status:** Diagnostic. The "pointer-effect halo" detector idea is dead.

## The user picked "Detect pointer-effect-snap icon outline"

In an earlier tick I offered four directions; the user chose detecting the iPadOS pointer-effect halo around icons. The hypothesis was: when cursor is on an icon, iPadOS renders a soft outline/halo around the icon, and shape-detect could lock onto that.

## What I actually saw

`test-phase304-pointer-effect-chunked.ts` drove the cursor toward each of Books/TV/Settings using chunked emits (20-mickey chunks, 30 ms pace — matching production `emitChunked`). Captured baseline (cursor at home) and snapped (cursor driven toward icon) frames. Computed per-pixel diff in a 200×200 region around each icon.

| Icon | Pixels with >10 brightness diff | Total diff sum |
|---|---|---|
| Settings | 122 | 36,427 |
| TV | 83 | 21,363 |
| Books | 324 | 21,980 |

The diff images show:

- **A small dark cursor arrow at a new position** (the cursor that wasn't there in the baseline). Position varies: cursor landed at the icon's right edge or short of the icon, NOT centered on it.
- **Scattered noise from JPEG / wallpaper rendering variation** — uncorrelated speckle.
- **ZERO visible change on the icon itself** — same gradient, same edges, same shadow.

## The verdict

**iPadOS pointer-effect does NOT highlight, halo, or visibly change the icon when cursor approaches.** There is no halo signature to detect.

The pointer-effect that I'd been blaming for failures is just the cursor itself changing shape (light-gray pointer-snap form, Phase 293's case) when over an icon. Phase 293 partially handles this via brightThreshold.

## Bonus finding: pointer-acceleration is non-linear

Cursor displacement vs emitted mickeys (single chunked emit from home):

| Emit (X mickeys) | Cursor moved (px) | Effective ratio |
|---|---|---|
| -129 (toward Settings) | -65 | 0.50 px/mickey |
| -239 (toward TV) | unknown (cursor invisible in crop) | — |
| -348 (toward Books) | ~-320 | 0.92 px/mickey |
| -100 (Phase 301b reference) | -120 | 1.20 px/mickey |
| -50 chunked × 7 (Phase 303 Test B) | -395 reached Books area | ~1.13 effective |

Small emits (10-50 mickeys per chunk) get the full ~1.2 ratio. Bigger chunks (anywhere near 127) get rate-reduced to 0.5-0.7 ratio. Production's default `chunkMag=20` is in the high-ratio regime, so production should be fine for emit transport.

## What this means for the 4 candidate directions

Returning to last tick's option set:

1. **Detect pointer-effect halo** — DEAD. No halo to detect.
2. **Smaller emit chunks** — Production already uses chunkMag=20 which is fine. Going smaller (chunkMag=10) doesn't help based on Phase 303 Test C (cursor faded during long fine-chunked emit).
3. **Cursor-belief slam-unstick on null** — still viable, not pursued this tick.
4. **Reduce Motion accessibility setting** — still viable, would need manual iPad toggle.

## So what's the actual cause of click rate failures?

Going back to first principles with what I now know:

- **Cursor reliably reaches the target area** when emits are chunked (production does this correctly)
- **Cursor lands at icon EDGE, not center** — pointer-snap pulls it to a stable snap position which may or may not be the icon's geographic center
- **Cursor in snap mode is light gray** — Phase 293 brightThreshold partially handles
- **Cursor's actual position has high natural variance** — same emit produces ±20 px variation due to iPad rendering pipeline

The Settings 30-50% click rate is the system reliably landing the cursor **somewhere in the Settings vicinity** ~50% of the time, then the detector correctly identifying that position ~50% of the time. The compounding gives the band.

For TV/Books at 0-15%: the cursor doesn't land in the target's vicinity reliably because pointer-acceleration changes mid-traversal (cursor decelerates as it gets close to an icon's snap zone, "sticking" before reaching the next icon over).

## State at end of phase

- v0.5.231 unchanged. No code change.
- Pointer-effect halo detection idea retired.
- The iPad's per-emit pointer-acceleration profile is non-linear and target-snap-aware — not something cursor-shape-detect can fix.
- 723/723 tests pass.

## Where to go next

The user's choices stand. Asking again would just delay. The honest constructive options:

1. **Accept** the current click rate (30-50% Settings, 0-15% others) and update user-facing docs
2. **Manually toggle Reduce Motion** on the iPad (out of band, can't be done via PiKVM per Phase 117)
3. **Cursor-belief slam-unstick** — implement a "when detection returns null and residual > N px, slam to a known position and retry the move" recovery path. This is upstream of cursor-shape-detect (modifies clickAtWithRetry / moveToPixel) but isn't a strategy pivot — it's a recovery primitive for already-broken state.

Per rule 4, I'm not implementing any of these without explicit direction.
