# Phase 244 (v0.5.211) — extend Phase 197 locality gate to correction pass

**Date:** 2026-05-10
**Version:** v0.5.211
**Status:** Shipped + live-verified.

## Problem

Phase 243 documented the bimodal detection pattern: the algorithm
either returns an accurate cursor position (within 5 px) or a
confident-wrong position 100+ px away (template false-positive on
saturated UI features like the clock widget).

The Phase 197 locality gate (`requireWithinRadius: true`) was
introduced for the OPEN-LOOP detection path in `move-to.ts:1682`.
But the CORRECTION-PASS template fallback at `move-to.ts:1925`
didn't pass the same flag. So when no template match landed within
150 px of the prevPos hint, `findCursorByTemplateSet` fell back to
the highest-scoring match anywhere on screen — exactly the iPad
UI false-positive class Phase 197 was supposed to defend against.

## Fix

Pass `requireWithinRadius: true` in the correction-pass call too.
When no near-cursor match exists, the function returns null, the
correction loop falls through to predicted-position trust (anchored
to expected cursor location, not a UI feature), and the
isStaleTemplateMatch guard never even fires for a wrong match.

```ts
// move-to.ts:1950 (added)
requireWithinRadius: true,
```

That's the entire change. One line + comment.

## Live verification (N=10 against baseline)

Same Phase 236 protocol at v0.5.211:

| metric           | v0.5.210 baseline | v0.5.211 Phase 244 |
|:-----------------|:-----------------:|:------------------:|
| within 35 px     |       2/9         |        1/5         |
| within 75 px     |       3/9         |        2/5         |
| null detections  |       1/10        |        5/10        |
| confident-wrong  |       6/9         |        2/5         |

**More nulls, fewer confident-wrongs.** The total "good" outcomes
(hits + safe nulls) goes from 3/10 to 6/10 — i.e. fewer trials
where the algorithm leads moveToPixel astray with a wrong position.

Per Phase 237's variance lesson, a single N=10 isn't conclusive on
click-rate impact. But the shift from confident-wrong → null is the
SEMANTICALLY desired direction: a null detection makes moveToPixel
fall back to predicted-position (which is anchored to expected
cursor), while confident-wrong sends it chasing a UI feature.

## Risk

Low. The change mirrors an existing, well-tested pattern (Phase 197).
Existing tests pin the option's behavior in template-set.test.ts;
711 tests pass with no changes needed.

If we observe end-to-end click rate REGRESS (more "skip click"
errors), the right response is to revert OR raise the
expectedNearRadius from 150 → 200 to give the cursor more space
before triggering the gate. The flag itself is correct.

## Why this is the right long-term fix

The correction-pass without locality gate had a logic bug: it
already trusted prevPos enough to set `expectedNear`, but didn't
trust it enough to refuse far-away fallbacks. Phase 244 closes that
inconsistency. Future template-match work (score-margin gate,
motion-diff cross-validation, negative-template list — all Phase
245+ candidates) builds on this consistent locality foundation.

## State

- v0.5.211 ships the fix
- 721/721 tests pass
- nix build green
- iPad ops verified
- Pushed to origin/main
