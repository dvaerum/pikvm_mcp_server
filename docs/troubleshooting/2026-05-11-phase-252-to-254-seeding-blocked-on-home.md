# Phase 252-254 — fresh template seeding is blocked on the home screen by three different iPadOS behaviors

**Date:** 2026-05-11
**Version:** v0.5.216 (no code change in these phases)
**Status:** H1 (stale cache) vs H2 (extraction leaks backdrop) remains
unanswered. THREE distinct iPadOS misbehaviors block every
pre-positioning strategy attempted. Each is a real finding worth
documenting.

## Why this chain ran

Phase 251 found that on the home screen, all 5 cached templates
score 0.45–0.81 (below 0.83 minScore) even though the cursor is
plainly visible. To distinguish "stale cache" from "broken extraction
itself," we needed to extract a FRESH template at the cursor's
current position and test it against the same frame.

That requires `seedCursorTemplate` to succeed on the home screen.
It doesn't, for the reasons below.

## Phase 252: clock widget dominates motion-diff

`test-phase252-fresh-vs-cached.ts` (no pre-positioning):

```
seedCursorTemplate result:
  ok=false
  cursorPos=(619,168)  — INSIDE clock widget bounds
  reason: looksLikeCursor rejected all 1 candidate cluster(s).
          Tried: (619,168) 175px → looksLikeCursor rejected.
```

Clock widget at top-left has an animating second hand. Motion-diff
sees its sweep as the largest cluster on the frame. `mergeClusters`
runs after the size filter and SUMS member pixels, so two 90-px
sub-clusters within `mergeRadius: 20` become one 180-px merged
cluster, beating the cursor's tighter ~85 px diff.

## Phase 253: slamToCorner triggers iPadOS 26 lock screen

`test-phase253-positioned-fresh-vs-cached.ts` (slamToCorner top-left
followed by chunked emit to mid-screen):

F0.jpg captured AFTER slam shows the iPad **on the lock screen**
("Mon 11 May / 06.42"). Cached templates max top-1 dropped to 0.570
because the cursor is now on the lock-screen wallpaper, a different
backdrop than any cached template.

`slamToCorner` runs 28 calls of `mouseMoveRelative(127×vec, 127×vec)`
at 60 ms pacing. Comment in `ballistics.ts:286-289` claims:
"60 ms between calls is slow enough for iPadOS to treat it as
ordinary pointer movement." This was true at the time it was written
but iPadOS 26 has tightened its gesture recognition (Phase 217 found
this with the unlock key change Space → Enter; Phase 219 with
swipe-on-home re-locking). 28×127 px at 60 ms now triggers the
lock-screen swipe gesture.

Alternative interpretation: the iPad's auto-lock fired during the
~4 minute gap between Phase 252 and Phase 253 runs. Can't
distinguish from a single trial. Either way, `slamToCorner` is no
longer safe for diagnostic positioning on this iPadOS.

## Phase 254: chunked emit clamps cursor at right edge + cursor fades

`test-phase254-emit-only.ts` (no slam, just chunked relative emits
of 80 right + 50 down × 12 to land cursor near (840, 600)):

Sanity capture (taken right after pre-positioning emits, before F0)
shows the cursor at the right edge ~(1148, 778). The chunked emits
overshot — cursor got clamped at the screen boundary.

F0 captured ~800 ms later shows the cursor **gone** — faded within
the gap. iPadOS auto-hides the soft cursor when no motion happens
for a few hundred ms.

```
seedCursorTemplate result:
  ok=false
  cursorPos=(1166,989)  — outside iPad's visible HDMI region
  reason: looksLikeCursor rejected all 1 candidate cluster(s).
          Tried: (1166,989) 56px → looksLikeCursor rejected.
```

The 56-px cluster is JPEG noise at the iPad/letterbox boundary
(visible iPad region right-edge is ~x=1156; cluster at x=1166 is
beyond it). looksLikeCursor correctly rejected.

## Pattern across the three phases

Every "clean state" the diagnostic created for the home screen
turned into a different failure mode:

| Phase | Strategy                       | Failure mode                                  |
|-------|--------------------------------|-----------------------------------------------|
| 252   | No pre-positioning             | Clock widget dominates motion-diff            |
| 253   | slamToCorner + chunked emit    | Lock screen triggered                         |
| 254   | Chunked emit only              | Cursor clamps at edge + fades before seed     |

This explains why the project's been stuck on click rate. Even
seeding a fresh template — the most basic operation upstream of the
detection pipeline — is brittle. Phase 248-251 parameter gates were
operating downstream of a broken upstream.

## H1 vs H2 — still unanswered

We still don't know whether:
- H1 (stale cache): a freshly-seeded template would clear 0.83
- H2 (extraction leaks): even fresh templates fail because Phase 106
  masking leaves wallpaper context

Both hypotheses require a successful fresh seed on the home screen.
Three approaches haven't worked.

## Next candidates (Phase 255+)

- **Larger seed wake-emit** with cursor first nudged left by a small
  amount to un-clamp from edge: `client.mouseMoveRelative(-200, 0)`
  then `seedCursorTemplate(client, { emitDx: 300, emitDy: 0 })`.
  Larger emit = more cursor diff area, beating the clock widget.
- **Seed during an APP** instead of home screen. Apps don't have
  the clock widget animation. `launchIpadApp(client, 'Files')`,
  then seedCursorTemplate. Then test the seeded template on the
  home screen (will it generalize?).
- **`mergeRadius` cap on cluster merging** during seed-only:
  reduce from 20 to 8 so widget sub-clusters don't merge into one
  oversized blob. Risk: cursor's anti-aliased edge might also have
  spread sub-clusters that should merge. Bench risk.
- **Two-stage seed**: short wake-emit to render cursor visible, then
  the actual seed with a larger emit. Already partially in
  seedCursorTemplate via screenshotKeepingCursorAlive but not as
  separate calls.

## Decision

**No code change shipped this session.** Per Phase 248/250 lesson:
ship after evidence, not before. The findings are the deliverable
of this tick.

## State

- v0.5.216 stable (no code change in 252-254)
- Tests pass (744/744)
- nix build green
- Bench scripts retained: `test-phase252-fresh-vs-cached.ts`,
  `test-phase253-positioned-fresh-vs-cached.ts`,
  `test-phase254-emit-only.ts`
- Trial frames at `data/phase{252,253,254}-*/`

## Why this chain matters

These three phases turned what was a vague "click ~25%" problem into
a specific upstream blocker: **seedCursorTemplate doesn't work
reliably on the home screen, and the home screen IS the canonical
test surface for the project's primary directive**. Future work
should target the seed reliability before any more
selection/rejection-rule tuning.
