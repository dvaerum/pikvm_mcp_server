> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# Phase 301-303 — rate-limit investigation: I was wrong (twice)

**Date:** 2026-05-13
**Status:** Diagnostic only. No code change needed.

## Why this exists

The user called out my contradiction: I claimed pointer-effect snap was the dominant problem in earlier ticks, then later claimed Phase 50 rate-limiting was the dominant problem. I had to actually investigate which (if either) is real.

## Phase 301: rate-limit probe (round 1)

Wrote a probe that sends raw `mouseMoveRelative` calls and measures cursor displacement via `findCursorByShape`. Result: all 12 trials reported cursor at (619, 261) — the calendar widget FP — because the standalone shape-detect call bypassed Phase 297's wiggle-verify gate. The test couldn't measure cursor motion. **First mistake: my test was broken.**

## Phase 301b: rate-limit probe via motion-diff (round 2)

Rewrote using `detectMotion` between pre/post frames. Motion-diff failed all 12 trials too (couldn't find cursor pair). **Second mistake: motion-diff has its own brightness/cluster thresholds that didn't match.**

## Phase 302: visual inspection of saved frames

Looked at the actual saved screenshots from Phase 301b. Cursor in pre-frame at (1060, 778). After -100 mickey emit, cursor at ~(940, 798). Movement: 120 px for 100 mickeys = ratio 1.20. **Close to expected.** No rate-limit at 100-mickey scale.

Then captured cursor on icons:
- After -129 mickey single emit toward Settings (target 905, 810): cursor at (995, 815). 65 px moved.
- After -348 mickey single emit toward Books (target 642, 810): cursor at (995, 815). **Same position as Settings test.**

The cursor stopped at the SAME place regardless of emit size. **The smoking gun: `mouseMoveRelative` silently CLAMPS to [-127, +127] per call** (HID int8_t range, `src/pikvm/client.ts:53-54`). My -348 emit got clamped to -127, which produces ~65 px of cursor movement at the iPad's pointer-acceleration ratio for that magnitude.

## Phase 303: chunking proves the diagnosis

Three tests aiming for Books target (642, 810):
- **A**: Single `-348` emit → cursor invisible / still near home (clamped to -127 → moved ~65 px) ✗
- **B**: 7 chunks of `-50` with 50ms between → **cursor at (665, 845) — REACHED Books area** ✓
- **C**: 35 chunks of `-10` with 30ms between → cursor faded by screenshot time (~2s of emit + settle) ✗

Confirmed: chunking large emits is necessary. Chunking works.

## The big reveal: production already chunks

`emitChunked()` at `src/pikvm/move-to.ts:972-994` properly splits large emits into chunks of `chunkMag` mickeys (default **20**) with `chunkPaceMs` pace (default **30 ms**). For a -348 emit, that's 18 chunks of -20 each, which doesn't hit the clamp.

So my "Phase 50 rate-limit is the dominant production problem" claim was **WRONG**. The clamp only affects callers that bypass `emitChunked` and call `mouseMoveRelative` directly — like my Phase 302 test did. The production click pipeline already chunks correctly.

## What I should have said all along

The actual dominant remaining failure mode for far targets is NOT rate-limit. With chunked emits production correctly transports the cursor near the target. The remaining failures are:

1. **Pointer-effect-snap on icons** makes the cursor visually change (light gray outline instead of dark arrow), evading dark-mask shape-detect. Phase 293 added bright-mask but it's still imperfect.
2. **Label-text false positives** at icon labels (Phase 296 finding). Phase 297 wiggle eliminates these, at the cost of refusing to report when cursor IS pointer-snapped (because snap-pulled cursors don't fully respond to wiggle either).
3. **Variance in detection** — some trials, motion-diff catches the cursor cleanly; others, it gets confused by widget animations near the target.

These are all detection-layer problems, which Phase 290/293/294/297/299 have addressed to the architectural ceiling. Phase 300's bigger-wiggle attempt regressed.

## My contradiction record

| Earlier tick claim | What I now know |
|---|---|
| "Pointer-effect snap is the dominant problem" | Partially right — snap IS real (icon highlights when cursor on it) |
| "Phase 50 rate-limit is the dominant problem" | Wrong — production chunks correctly, no rate-limit in production |
| "It's both" | Closer — snap is real but minor; rate-limit only affects bypassing callers (test code) |
| "Detection is at architectural ceiling" | Still true. The 30-50% Settings honest rate is the system's real performance. |

## State at end of phase

- v0.5.231 unchanged. No code modification this tick.
- Settings click rate: 30-50% honest variance band (multiple runs across recent ticks)
- TV / Maps / Books: 0-15% — cursor DOES reach via production chunking, but detection in icon-area pointer-effect mode is unreliable
- Production `emitChunked` is correct; my Phase 50 framing was misleading
- 723/723 tests pass

## What didn't change

The 4 documented next-step levers stand. All are upstream of cursor-shape-detect.ts:
1. iPad Reduce Motion accessibility setting (manual toggle)
2. Smaller chunk magnitude (e.g. chunkMag=10) — might help but Phase 303 test C showed cursor fades during long fine-chunked emits
3. Cursor-belief slam-unstick on null
4. Acceptance of 30-50% Settings ceiling

The pointer-effect halo idea (the user picked in last decision) would be a real detector improvement IF we can characterize the halo signature. Phase 302's diff between baseline (cursor at home) and "snapped" (cursor near icon) showed ZERO pixel difference in the icon's 160×160 crop. That means either (a) cursor never actually reached the icon (single-emit clamp issue, see above), or (b) pointer-effect-on-icon doesn't change pixels in the icon's area at all on this iPad/iPadOS combo.

To properly test (b), I'd need to drive cursor to icon via CHUNKED emit, then capture baseline vs snapped. Not done this tick.
