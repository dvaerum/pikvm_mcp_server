# Phase 281 — NCC has been silently broken on the current iPad state

**Date:** 2026-05-11
**Version:** v0.5.225 (no code change — diagnostic)
**Status:** Root cause found. The story of all recent phases is wrong.

## The big finding

NCC (template-match), the **primary** cursor detector, has been
returning **null on every frame from the current iPad home screen**
because the cached templates don't match the current iPadOS cursor
appearance.

The shape-detect FP problem we've been chasing for Phases 268-280
is a downstream symptom: when NCC fails, the fallback (shape-detect)
runs, and shape-detect's high-confidence widget FPs (clock face at
1.5+ score) win.

If NCC scored the real cursor correctly, shape-detect would never
be called for these frames.

## Evidence

Phase 281 ran `findCursorByTemplateSet` against 5 saved frames from
Phase 280 with full diagnostic verbosity:

| Frame | Truth cursor | NCC best (unhinted) | Score | NCC prod default | Shape-detect |
|---|---|---|---|---|---|
| f023 | (733, 770) | (676, 415) | 0.780 | null | (733, 777) ✓ |
| f024 | (720, 770) | (676, 415) | 0.788 | null | (719, 777) |
| f025 | unclear | (636, 470) | 0.793 | null | (618, 260) |
| f033 | unclear | (676, 415) | 0.780 | null | (627, 149) clock-FP |
| f045 | unclear | (676, 415) | 0.788 | null | (626, 149) clock-FP |

**Production threshold is minScore=0.83.** NCC never reaches it.
NCC at default settings returns **null on 5/5 frames**.

Even when I forced NCC to look near the known cursor at (733, 770)
±100 px, it returned (676, 415) — 358 px from the real cursor. The
real cursor is not findable by NCC against the 23 cached templates
at any threshold above 0.78.

In f023, where the cursor is visibly at (733, 770) and shape-detect
correctly scores it 2.919 (clear win), NCC's best correlation
anywhere is 0.78 in the weather-widget area — completely missing
the real cursor.

## Why this rewrites the story

Phases 274 (multi-cycle avg), 276 (proximity gate), 277 (locality
radius), 278 (lift confirmation), 279 (progressive A/B), 280
(vanishing diagnostic) all measured behaviour AT shape-detect.
They couldn't measure NCC because NCC was silently returning null
and falling through.

The shape-detect "production ceiling" of ~50% near / ~0% far isn't
the detector's ceiling — it's **the rate at which shape-detect's
local heuristics happen to land near a real cursor after NCC's
silent failure**.

## Why the templates are stale

The 23 templates in `data/cursor-templates/` are tiny (300-750 bytes
each). Visually they look like small dark blobs — possibly an older
iPadOS cursor style (a round/oval pointer) rather than the current
arrow cursor visible in Phase 280 screenshots.

iPadOS may have updated cursor rendering, or the templates may have
been captured against a different context (lock screen, app, etc).
Either way they no longer correlate with what the cursor looks like
on the home screen today.

## The fix

**Re-seed the cursor template set against the current iPad state.**
This is the single highest-leverage action available.

Phase 280's f023 frame (cursor visible at ~(733, 770)) is ideal
training data. Two paths:

1. **Use `pikvm_seed_cursor_template` MCP tool** — this is the
   designed mechanism. Calls `seedCursorTemplate` to wake the cursor
   and extract a fresh template against a known wallpaper backdrop.
   Already integrated into production cache lookup.

2. **Manually extract from Phase 280 f023** — open the JPG, crop
   the cursor at (733, 770) ±15 px, save as `data/cursor-templates/
   manual-current.jpg`. Then re-run Phase 281 NCC investigation to
   verify the fresh template scores 0.85+ against the real cursor.

Path 1 is the production-clean approach. Path 2 is the fast
diagnostic to verify the staleness hypothesis is correct before
committing to a re-seed strategy.

## What this means for Phase 282 (stroke topology)

Still valuable, but the priority drops. If NCC scores the real
cursor at 0.85+ after re-seed, shape-detect will rarely be invoked
during normal moveToPixel runs and the clock-FP problem becomes
mostly invisible. Stroke topology becomes a defence-in-depth fix
rather than a primary lift.

## State at end of phase

- v0.5.225 (unchanged)
- 713/713 tests
- nix build green
- This phase: investigation script + this doc
- Next: live re-seed via `pikvm_seed_cursor_template` (or manual
  extract from f023) then re-run Phase 281 to confirm lift
