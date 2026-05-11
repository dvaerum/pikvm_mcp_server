# Phase 256 — cursor fade time is ≥ 10 sec, NOT ~200ms (correction)

**Date:** 2026-05-11
**Version:** v0.5.217 (comment correction only; no behavior change)
**Status:** A foundational claim used to justify the cursor-keepalive
machinery turns out to be wrong. The cursor stays visible far longer
than documented. The user observed ~7 seconds visually; empirical
measurement confirms ≥10 seconds in PiKVM HDMI capture.

## The wrong claim

`src/pikvm/seed-template.ts:104-107` said:
> "The cursor fades within ~200ms of the last emit; PiKVM screenshot
> round-trip is 300-500ms — without keepalive, the after frame
> commonly has no visible cursor and motion-diff finds zero clusters."

The 200-300 ms figure was an unverified assumption that propagated
into the troubleshooting docs (e.g. my own "cursor fades within ~300ms
of no motion" answer to the user in this session).

## The measurement

`test-phase256-fade-time-v2.ts`:
1. Unlock + home + 10 continuous emits to make sure cursor renders
2. Final emit at t=0, then screenshot at t = 186, 290, 687, 1150,
   2144, 4207, 7156, 10123 ms — NO further emits in this period

Results (visual inspection of `data/phase256-fade-v2/t-*ms.jpg`):
- t+186ms: cursor clearly visible at (~755, 470) in weather widget
- t+687ms: cursor visible same spot
- t+2144ms: visible
- t+7156ms: visible
- t+10123ms: **still visible 10 seconds after last emit**

The 31-cluster diff jump between t+7156 and t+10123 (6040 px) was
not the cursor fading — visual inspection confirms cursor is in
both frames. The cluster was probably the weather widget refreshing
its "Mostly Cloudy" text rendering or similar widget activity.

## What this means

The user's 7-second observation was correct. My 300ms claim was
parroting a wrong code comment without measuring.

This invalidates a justification for several pieces of architecture:

1. **`screenshotKeepingCursorAlive` (Phase 202+)** — the function
   adds a tiny pre-screenshot mouse wiggle to ensure the cursor is
   visible. If the cursor stays visible for 10+ seconds anyway, the
   wiggle is doing nothing useful most of the time. It MAY still be
   useful in specific edge cases (HDMI frame drops, iPad rate-limit
   during back-to-back screenshots), but the "cursor faded — must
   wake it" model is wrong.

2. **Phase 254's "cursor faded before seed could capture"
   interpretation** — that doc claimed the cursor faded within ~800ms
   between the pre-position emit and the seed call. The correct
   explanation is probably different: the cursor may have been
   clamped at the screen edge (HDMI letterbox edge), or the seed's
   own wake-emit didn't generate enough motion-diff because the
   cursor was already at the right edge and couldn't move further.

3. **Several comments in code talking about "cursor fade timing"**
   need re-evaluation. Quick grep:
   - `src/pikvm/seed-template.ts:104-107` — fixed in this commit
   - `src/pikvm/cursor-keepalive.ts` — needs re-evaluation in a
     future tick
   - `docs/troubleshooting/*` — multiple docs reference the wrong
     figure; not retro-editing each one but noting it here

## Lessons

- **Measure before claiming timing.** Especially when the timing
  drives an entire defensive subsystem (keepalive wiggle).
- **Don't trust code comments as primary source.** A comment is
  someone else's claim. Verify when it matters.
- **The user's direct observation was a stronger signal than my
  inherited assumption.** Listen to it earlier.

## What this means for the user's other question

The user also asked: "is motion-diff when useful? I do not
understand like are we not using image recognition to find the
cursor."

The fade-time correction strengthens the case that **motion-diff
might be less essential than its prominence in the codebase
suggests.** If the cursor stays visible for 10 seconds after the
last emit, image recognition (template matching on a static frame)
should work fine for most "where is the cursor right now?"
queries. Motion-diff was useful for the bootstrap problem (getting
the FIRST template) and as a fallback when templates fail, but
the codebase routes through motion-diff in many places where a
single screenshot + template match would suffice.

This is now a Phase 257+ candidate: audit the cursor-detection
pipeline to see which motion-diff calls are actually necessary
vs leftover defensive code.

## State

- v0.5.217 (no behavior change; just comment correction in
  `seed-template.ts`)
- Bench script `test-phase256-fade-time-v2.ts` retained
- Trial frames at `data/phase256-fade-v2/`
- Tests still 697/697
- Nix build green
