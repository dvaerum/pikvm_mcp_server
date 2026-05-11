# Phase 255 — cleanup of opt-in dead weight

**Date:** 2026-05-11
**Version:** v0.5.217
**Status:** Removed three opt-in options that shipped as "harmless
default-off escape hatches" but accumulated as dead code without
demonstrated click-rate benefit. Lessons preserved in the existing
troubleshooting docs (not duplicated here).

## What was removed

### Phase 191 inter-retry approach randomization
- `ClickAtWithRetryOptions.interRetryJitterMickeys` field
- `jitterOffsetForAttempt(attemptIndex, magnitude)` helper
- `defaultInterRetryJitterFor(mouseAbsoluteMode)` helper
- The compass-rosette emit logic inside `clickAtWithRetry`'s retry loop
- MCP `pikvm_mouse_click_at.interRetryJitterMickeys` schema entry
- MCP handler's `defaultInterRetryJitterFor` resolution
- `src/pikvm/__tests__/jitterOffsetForAttempt.test.ts` (deleted)
- `src/pikvm/__tests__/defaultInterRetryJitterFor.test.ts` (deleted)
- `Phase 191: inter-retry approach randomization` describe block in
  `src/pikvm/__tests__/click-retry.test.ts`
- Regression test pinning `interRetryJitterMickeys` in MCP schema

**Why removed:** Phase 192-D (v0.5.184) A/B (5 trials per side,
2026-05-09) showed jitter-on at -20 pp vs baseline. The premise — that
retry failures are correlated by similar trajectories and a rosette
breaks the correlation — was indirect reasoning, not measured data.
The principled replacement is Phase 192-D's `belief.isAtEdge()`
unstick at retry start, which is still there and fires only when
the cursor is actually pinned.

### Phase 248/249 known-FP blocklist
- `FindCursorOptions.fpBlocklist` field
- `MoveToOptions.fpBlocklist` field + threading at both call sites
- `KNOWN_HOME_SCREEN_FPS_1680x1050` constant
- `isWithinKnownFp` predicate
- Rejection logic in `findCursorByTemplateDecoded`
- MCP `pikvm_mouse_click_at.useKnownFpBlocklist` schema entry
- MCP handler that routed the boolean to the blocklist
- `src/pikvm/cursor-fp-blocklist.ts` (entire file deleted)
- `src/pikvm/__tests__/cursor-fp-blocklist.test.ts` (entire file deleted)
- Regression test pinning fpBlocklist threading in
  `locality-gate-pinning.test.ts`
- Regression tests pinning useKnownFpBlocklist in MCP schema

**Why removed:** Cumulative N=60 with blocklist = 26.7% vs N=40
baseline = 30% within 35 px. No measurable click-rate benefit. The
blocklist was semantically correct (rejects 3 visually-confirmed
FPs at (852,941), (773,769), (782,958)) but those FPs aren't the
dominant failure mode — Phase 251 showed templates fail to clear
0.83 minScore at any position, not "match confidently at a known
FP location."

### Phase 250 score-margin ambiguity gate
- `FindCursorOptions.scoreMargin` field
- `MoveToOptions.scoreMargin` field + threading at both call sites
- The "AMBIGUOUS" rejection logic in `findCursorByTemplateDecoded`
- Regression test pinning scoreMargin threading
- `test-phase250-gate-fires.ts` bench script

**Why removed:** N=10 diagnostic at recommended `scoreMargin: 0.03`
fired 0/10 times on the home screen. Phase 251 explained why: the
gate compares cross-template top-1 vs other-template top-1, but the
real failure mode is "all templates fall below minScore" — there's
no cross-template ambiguity to gate against.

## What was kept

- **Phase 192-D `belief.isAtEdge()` unstick at retry start.** Still
  in `clickAtWithRetry`. Fires only when belief reports pinned edge.
  Principled replacement for the rosette jitter.
- **Phase 251 `topK` diagnostic.** Opt-in default-undefined logging
  knob on `FindCursorOptions` and `MoveToOptions`. Useful for
  future template-match investigations. NOT exposed to MCP — it's
  a developer-only tool.
- **Phase 197 + Phase 244 `requireWithinRadius:true`.** The
  locality gate that returns null instead of confidently-wrong far
  matches. Has demonstrated effect (Phase 244 reduced confident-
  wrong responses). Stays.

## Surface impact

- `src/pikvm/cursor-detect.ts`: -52 lines (option declarations + reject logic)
- `src/pikvm/move-to.ts`: -16 lines (option declarations + threading × 2)
- `src/pikvm/click-verify.ts`: -78 lines (option, helpers, wiring)
- `src/index.ts`: -8 lines (schema entries + handler)
- 3 deleted source files (cursor-fp-blocklist.ts, 2 helper test files)
- 1 deleted bench script (test-phase250-gate-fires.ts)
- ~47 deleted tests (697/697 passes vs 744/744 before)

## Discipline applied

The user flagged the pattern: "we keep finding things that don't
work, but we keep them as opt-in defaults." This cleanup applies
the Phase 248/250 lesson at the file level: **if an option shipped
opt-in default-off and the data showed no benefit, delete it
rather than keeping it as 'just in case.'**

The lessons stay in their original troubleshooting docs:
- `docs/troubleshooting/2026-05-11-phase-250-score-margin-gate-doesnt-fire.md`
- `docs/troubleshooting/2026-05-11-phase-251-topk-shows-templates-stale.md`
- `docs/troubleshooting/2026-05-11-phase-252-to-254-seeding-blocked-on-home.md`
- `docs/troubleshooting/2026-05-09-phase-192d-jitter-no-lift.md` (Phase 191 supersedence)
- `docs/troubleshooting/2026-05-11-phase-248-blocklist-walkback.md` (if exists; otherwise the Phase 215 state memory captures it)

## State

- v0.5.217
- 697/697 tests pass
- nix build green
- Working tree clean after commit + push
