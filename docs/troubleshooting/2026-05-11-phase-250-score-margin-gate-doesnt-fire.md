# Phase 250 — score-margin ambiguity gate (negative result at scoreMargin=0.03)

**Date:** 2026-05-11
**Version:** v0.5.215 (option shipped, opt-in default-off)
**Status:** Hypothesis from Phase 243 not supported at scoreMargin=0.03. Option shipped but disabled by default.

## What was shipped

Phase 250 added an opt-in `scoreMargin` option to
`FindCursorOptions` and `MoveToOptions`. When set, after picking
the winning template match, the function looks for the highest-
scoring runner-up at >30 px from `best`. If the score gap is
smaller than `scoreMargin`, the match is treated as ambiguous and
null is returned (caller falls back to predicted-position trust,
same path Phase 244 documented as safe).

Same opt-in shape as Phase 248 fpBlocklist. Default undefined =
fully back-compat.

## Hypothesis (from Phase 243)

iPad UI features (clock widget, TV icon, wallpaper gradients) tend
to score similarly to each other when template-matched; the real
cursor, when present, dominates cleanly. A small margin gate would
convert confident-wrong UI-feature matches to safe nulls without
losing real cursor detections.

## Diagnostic test (N=10 with verbose=true at v0.5.215)

`test-phase250-gate-fires.ts`: counts how many times the gate
emits its `[template-match] AMBIGUOUS` log line. Single moveToPixel
calls to (905, 800), `scoreMargin: 0.03`, verbose=true.

**Result:** Gate fired **0 times across 10 trials.** Trial residuals
were 19, 19, null, 19, 19, 99, null, 157, 143, 47 — bimodal as
expected (4 hits at 19 px, 5 misses at 47-157 px, 2 nulls). The
gate did NOT trigger on any of the misses.

## Interpretation

At `scoreMargin: 0.03`, the hypothesis is not supported. Either:

1. **FP scores don't cluster within 0.03 of each other.** The Phase
   243 visual evidence showed that FPs at (852, 941), (773, 769),
   etc. existed, but didn't measure how close in score they were to
   the second-best match anywhere on screen. They may be isolated:
   one strong FP at 0.91 and the runner-up at 0.78.

2. **The bimodal failure is per-template, not cross-template.** A
   single template applied at multiple positions could find the FP
   strongly without any other position scoring close. The gate
   compares cross-template (one match per template); it can't see
   intra-template alternatives at all.

3. **scoreMargin=0.03 is too tight.** Could try 0.05, 0.10. But
   per Phase 248 lesson, parameter sweeps need N>=100 each — too
   expensive for cron-tick budget.

The most likely explanation is (2). `findCursorByTemplateDecoded`
returns only the top-1 match per template; the runner-up the gate
inspects is the best of OTHER templates' top picks, not the second-
best match within one template.

Fixing (2) would require changing `findCursorByTemplateDecoded` to
return top-K matches — substantial new logic.

## Decision

**Keep Phase 250 option shipped (opt-in default-off, no production
risk).** It's harmless if not enabled and can be revisited if a
different scoreMargin or top-K template-match implementation
arrives.

**Do NOT propagate Phase 250 to MCP tool surface.** Phase 248/249's
useKnownFpBlocklist had at least a semantic argument (rejects
visually-confirmed FPs). Phase 250 has no demonstrated effect at
the recommended starting value.

**Update memory + main detection log:** Phase 250 = "shipped,
hypothesis not supported at scoreMargin=0.03, option harmless and
documented for future revisit."

## What stays open

The next investigation should distinguish per-template vs cross-
template FP scoring. Modify `findCursorByTemplateDecoded` to log
top-K matches (verbose only); run on the FP-prone home screen;
look at whether any single template returns multiple ≥0.83 matches
at distinct positions. That would inform whether a per-template
margin gate would help.

For this session, the right discipline is to acknowledge the
negative result and stop. Per Phase 248 lesson, don't ship more
parameter-tuning candidates without strong evidence of effect.

## State

- v0.5.215 stable
- 743/743 tests pass (no test removed; Phase 250 regression test
  pins the threading remains in place even though the gate isn't
  recommended)
- nix build green
- Bench script `test-phase250-gate-fires.ts` retained
- Trial data at `data/phase250-gate-fires/`
