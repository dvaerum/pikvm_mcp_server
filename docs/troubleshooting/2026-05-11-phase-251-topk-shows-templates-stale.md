# Phase 251 — top-K diagnostic uncovers stale templates, not intra-template ambiguity

**Date:** 2026-05-11
**Version:** v0.5.216 (diagnostic-only `topK` option shipped, opt-in)
**Status:** Hypothesis from Phase 250 disproven. Bigger finding: templates
fail to reach 0.83 minScore on the live home-screen frame even though
the cursor is visible. Re-frames the lever from "rejection gates" to
"template freshness / context coverage."

## What was added (production)

`FindCursorOptions.topK?: number` and `MoveToOptions.topK?: number`.
When set together with `verbose: true`, `findCursorByTemplateDecoded`
logs the top-K highest-scoring positions per template (deduped within
`step*2` px so adjacent samples on the same correlation hill collapse).
Diagnostic-only — does NOT change selection. Default undefined =
no extra logging.

Same opt-in shape as Phase 248 fpBlocklist and Phase 250 scoreMargin.

## The diagnostic and its result

`test-phase251-topk-diagnostic.ts`: take 5 home-screen frames, run
each cached template (5 within 6h TTL, 6 expired) with `topK: 5,
verbose: true, minScore: 0`. Per-template summary across N=5 trials:

```
idx | mean(top1) | mean(top2) | trials w/ top2≥0.83 | trials w/ top2 at distinct spot
----+------------+------------+---------------------+--------------------------------
  0 |   0.799    |   0.794    |       0/5            |       0/5
  1 |   0.807    |   0.799    |       0/5            |       0/5
  2 |   0.450    |   0.400    |       0/5            |       0/5
  3 |   0.668    |   0.656    |       0/5            |       0/5
  4 |   0.682    |   0.669    |       0/5            |       0/5
```

**Verdict line printed by the script:** "Per-template topK is NOT the
lever. Each template returns one confident match (true OR false); no
internal ambiguity."

But the more important observation when looking at the data:

**No template's top-1 reaches 0.83 minScore at any position on the
frame.** The whole template-match path returns `null` and falls
through to motion-diff or predicted-position trust.

## Visual confirmation (screenshot is source of truth)

`data/phase251-topk/trial1.jpg` is the home-screen frame the
diagnostic ran against. The cursor is **clearly visible** at
approximately (1063, 778) — the small dark arrow between the
Settings icon and the wallpaper area on the right.

Templates 0 and 1 score their best match around (748, 415-470) at
~0.80 — that's the **clock widget area**, not the cursor. The top-K
list shows the same Y, X stepped by ~40 px — classic single-peak
correlation hill against widget contour, not multiple widgets.
Templates 2-4 score even worse (0.45-0.68).

So the templates aren't picking up false positives at high score —
they're failing to match the actual cursor at a high enough score to
be selected at all.

## Re-interpretation of Phase 243's "bimodal" pattern

Phase 243 documented the bimodal failure: residuals cluster ≤5 px
or 100+ px. The Phase 250 hypothesis was "cross-template the high
residuals come from a confidently-wrong template-match." Phase 251
data refines this:

- When templates DO confidently match (0.83+), it's almost certainly
  the right cursor (≤5 px residual case).
- When templates DON'T (today's case — all under 0.83), motion-diff
  or predicted-position trust takes over. Predicted-position has its
  own px/mickey ratio variance that produces the 100+ px residuals
  documented in Phase 192-B trajectory captures.

So the bimodal isn't cross-template OR intra-template ambiguity. It's
"template confident vs. template silent + fallback to noisy predict."
That changes the next step.

## What's actually the lever

- **Template freshness against current backdrop.** Phase 215 already
  re-seeds on demand, but at 6h TTL and ad-hoc seeding the cache
  drifts away from the current cursor's rendering context (different
  wallpaper region = different mean-corrected NCC = lower score).
- **Wider template-set coverage.** Templates were captured at one
  backdrop region; the cursor at a different region scores lower
  because the masked template is still slightly contaminated by its
  original surround.
- **Context-conditioned re-seeding.** When detection fails, capture
  a fresh template at the predicted-cursor position and add it to
  the set. This is what Phase 215 was supposed to do but the
  trigger condition is too lenient.

These are NOT cron-tick-sized changes. They each need careful
investigation, not parameter sweeps.

## Decision

- **Keep Phase 251 `topK` option shipped (opt-in, default undefined).**
  Genuinely useful diagnostic for any future investigation.
- **Do NOT add per-template top-K selection logic.** Data shows it's
  not the lever — there's no ambiguity to resolve.
- **Do NOT propagate `topK` to the MCP tool surface.** It's a
  developer/troubleshooting option, not a runtime tuning knob.
- **Update the project memory** with the re-interpretation: the
  bimodal failure is "confident-correct vs. silent + noisy fallback,"
  not "confident-correct vs. confident-wrong."

## What stays open

- A live experiment: force a fresh template seed at the start of
  the diagnostic, then re-run. Does the freshly-seeded template score
  ≥0.83 on the same frame? If yes, "stale cached template" is
  confirmed as the dominant failure cause and the next phase is
  "more aggressive context-conditioned reseeding."
- A deeper look at the masked-template extraction (Phase 106): is
  the mask actually tight enough? Or is it leaving wallpaper pixels
  in the template that hurt NCC against new backdrops?
- Whether motion-diff (the OTHER observation source feeding cursor-
  belief) returns confident-wrong clusters when template falls
  through. Needs its own diagnostic.

For this session, the right discipline is the same as Phase 250:
acknowledge the finding, ship the diagnostic, do NOT bolt on more
parameter knobs. The honest path forward is a focused re-seed
experiment in a future tick, not more selection-rule tuning.

## State

- v0.5.216 stable
- Tests pass (no test removed; Phase 251 regression test pins the
  threading of `topK` through both call sites in `move-to.ts`)
- nix build green
- Bench script `test-phase251-topk-diagnostic.ts` retained
- Trial data + frames at `data/phase251-topk/`
