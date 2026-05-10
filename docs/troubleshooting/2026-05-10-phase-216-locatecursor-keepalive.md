# Phase 216 — locateCursor uses Phase 202 keepalive screenshots

**Date:** 2026-05-10
**Version:** v0.5.204
**Status:** locateCursor now succeeds on home screen; end-to-end click rate
still has remaining issues (open-loop motion-diff fails to verify
landing). Single-trial verbose confirmed the fix lifts locateCursor
from "1 cluster (need ≥2)" to a real probe pair.

## What changed

`src/pikvm/cursor-detect.ts:374-394` — `takeRawScreenshot` now uses
`client.screenshotKeepingCursorAlive` if the client exposes it
(Phase 202 added the keepalive variant), falling back to the plain
`client.screenshot()` for back-compat with test mocks.

The plain `client.screenshot()` returns a frame from the streamer's
buffer that may be 300+ ms stale. By the time it lands, the iPadOS
cursor often has faded (the cursor fades within ~200 ms of the last
emit). The keepalive variant emits a tiny ±1 px wake nudge before
each capture so the cursor stays rendered through the screenshot.

## Why this fixes locateCursor

`locateCursor` works by:
1. Wake-up move (-120, 0)
2. Settle, BEFORE screenshot
3. Probe move (+probeDelta, 0)
4. Settle, AFTER screenshot
5. Diff BEFORE vs AFTER → expect TWO cursor-sized clusters (pre and
   post position)
6. Pair them, return offset

Live-trace 2026-05-10 at v0.5.203 (before this fix):
```
[locateCursor] attempt 1: 3 total, 1 cursor-sized [4-90px] (need ≥2)
[locateCursor] attempt 2: 3 total, 1 cursor-sized [4-90px] (need ≥2)
```

The BEFORE frame had no visible cursor (faded between wake-up and
the screenshot landing). The diff only saw the cursor in the AFTER
frame as ONE cluster — pair selection couldn't find a partner.

After Phase 216 at v0.5.204:
```
[locateCursor] pre=(636,300) post=(734,282) offset=(98,-18) — cursor now at post
[move-to] CALIBRATION X ratio from probe: 1.633; still need Y probe
```

Two clusters detected, paired correctly, offset returned, calibration
established.

## Live verification

Single-trial verbose run at v0.5.204:
- `unlockIpad` + `ipadGoHome { forceHomeViaSwipe: true }` reaches home
- `moveToPixel({x: 905, y: 800})` proceeds past discoverOrigin (which
  used to throw) and runs the open-loop emit
- Open-loop motion-diff at the destination still fails: "no pre
  candidate within 120px of expected start (and only 1 sized cluster
  total)"
- The `pickNearestPlausibleMatch`-style template-match scores 0.661
  (below the 0.85 threshold)
- Algorithm trusts prediction and reports "residual 0.1px within
  linear tolerance 3px; done" — but `finalDetectedPosition` is null
  because verification failed

## What's still broken

The post-emit verification (motion-diff at the landing) still fails
because:
1. Single masked template doesn't generalize across iPad backgrounds
   (Phase 215 finding) — the cursor pixels are wallpaper-tinted by
   JPEG bleed
2. The cursor at the destination may be on yet another background,
   so the seeded teal-tinted template doesn't NCC well

This means the click pipeline can now START correctly (knows where
cursor is initially) but can't VERIFY where it landed. The
`maxResidualPx=35` safety gate skips the click since `finalDetectedPosition`
is null and residual can't be computed.

## Phase 217 candidate

The remaining lever is post-emit verification. Two directions:

1. **Lower discovery minScore to 0.65** for post-emit template-match
   when expecting the cursor near a known spot (the algorithm just
   emitted toward a target, so the cursor SHOULD be near it). The
   locality filter (expectedNear with radius 150) already protects
   against UI false positives — a 0.66 score within 150 px of the
   target with locality enforced is more likely a real cursor than
   a coincidence. Phase 131 raised it to 0.85 BUT that was without
   the locality filter; the filter is now reliable so a lower score
   floor is safer.

2. **Multi-template seeding** — populate the SET with templates over
   different home-screen regions during a session. Phase 216 multi-
   template bench: 1/5 attempted seeds succeeded — the cursor faded
   in 4/5 because seedCursorTemplate uses its own
   screenshotKeepingCursorAlive correctly, but the additional
   moveTo step before seeding has its own fade window. Each
   pre-position move needs its own keepalive cycle.

Both are moderate-scope changes. Phase 216 is the unblocker; Phase
217 is the next concrete lift.

## Files in this commit

- `src/pikvm/cursor-detect.ts` — keepalive in takeRawScreenshot
- `package.json` + `src/version.ts` — v0.5.204
- `test-phase216-multi-template.ts` — Phase 216 bench script
- `docs/troubleshooting/2026-05-10-phase-216-locatecursor-keepalive.md`
  — this doc

## State

- 691/691 tests green
- Nix build green at v0.5.204
- locateCursor verified working live on home screen
- Click bench end-to-end still 0/10 correct-element (Phase 217 work)
