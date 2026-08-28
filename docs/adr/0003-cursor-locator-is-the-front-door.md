# CursorLocator is the front door for "where is the cursor?"

## Status

accepted (2026-08-24)

## Context

`src/pikvm/cursor-locator.ts`'s `CursorLocator` was built (originally as
"Candidate 1 / Phase 1" of a since-deleted planning doc — see its own header
comment for the current pointer, this ADR) as one front door for cursor
detection: a single class, named **profiles**
(not one merged cascade), each reproducing an existing call site's detector
sequence call-for-call so a caller could be rerouted through it with a
byte-identical-on-hardware guarantee. Every detector/device function a
profile calls is injected via `deps` rather than imported at module scope,
so unit tests can substitute stubs and assert exact call order.

Four profiles were originally defined: `origin`, `openLoopShape`, `verify`,
`curve`.

## Decision

**`origin`, `openLoopShape`, and `curve` are live** — real production call
sites were rerouted through them:

- `origin` — `move-to.ts`'s `discoverOrigin` (V8 → motion-diff probe →
  template-set progressive wake).
- `openLoopShape` — `move-to.ts`'s open-loop correction path (ML wiggle-verify;
  see the F4 follow-on note below — the shape fallback this profile once had
  is gone).
- `curve` — `curve-mover.ts`'s `detect()` (V8 full-frame, parameterised by
  `minPresence`).

**`verify` was never wired to a real call site and is deleted** (this ADR).
Its doc comment described it as mirroring "click-verify.ts second-opinion
(~809): template match arbitrated by shouldFireSecondOpinion /
shouldAdoptSecondOpinion → V8 full-frame fallback" — but no code anywhere in
the current tree calls `locate(..., 'verify', ...)` except its own now-deleted
test suite. `shouldFireSecondOpinion` / `shouldAdoptSecondOpinion`
(`click-verify.ts`) had exactly one real caller: `locateVerify` itself — so
removing the profile didn't strand a live consumer, it removed the only one
that ever existed. Whatever caller Phase 3 of the locator-collapse plan meant
to reroute through `verify` either never landed or was refactored away before
this profile got a real hookup; either way, keeping unreachable scaffolding
around (a whole profile + 2 injected-only predicate functions + 5 tests) with
no path to ever exercising it on real hardware is worse than deleting it —
it invites a future reader to assume it's load-bearing.

Removed as part of this change:
- `'verify'` from the `LocateProfile` union and its `switch` case.
- The private `locateVerify` method.
- `shouldFireSecondOpinion` / `shouldAdoptSecondOpinion` from
  `CursorLocatorDeps`, and the corresponding `notWired(...)` stub entries in
  `move-to.ts`'s and `curve-mover.ts`'s deps builders.
- The `describe('locate(profile: verify)', ...)` test block (5 tests) in
  `cursor-locator.test.ts`.

**Deliberately NOT removed**: the `shouldFireSecondOpinion` /
`shouldAdoptSecondOpinion` function *definitions* in `click-verify.ts` are
now fully orphaned (zero callers anywhere) as a consequence of this
deletion — but they stay. They're pure regression-knowledge artifacts
pinning a real, previously-observed bug (Phase 140 caught motion-diff
picking an icon-LABEL feature 30px below the real cursor live; a
Phase-296 report showed the same bug class recurring weeks later).
Deleting them as "unused" would lose that record. See the signpost
comment at their declaration in `click-verify.ts` for the full context —
if a future caller needs second-opinion arbitration again, they're ready;
if not, they still document a bug class worth remembering.

## Follow-on: F4 (Round 2 Phase 2b, 2026-08-26) — deleted 2 more dead deps members

`findCursorByShape` and `wiggleVerifyCandidate` were two more `CursorLocatorDeps`
members in the same shape as `verify`'s stranded scaffolding above: wired/stubbed
by all 3 deps builders (`move-to.ts`'s two, `curve-mover.ts`'s one), but never
once referenced inside `CursorLocator`'s own class body — `locateOpenLoopShape`
had already dropped the shape-fallback branch entirely (see the "shape fallback
RETIRED" comment at its `return null` — `bench-shape-vs-cascade-backgrounds`
proved it dead+harmful, 2026-07-23, tracked in `docs/FUTURE-WORK.md`), so these
two deps became orphaned scaffolding the same way `verify`'s predicates did:
wired for a caller that no longer calls them.

Deleted: both members from `CursorLocatorDeps`; the real wiring
(`findCursorByShape` at `move-to.ts`'s `makeLocatorDeps`, `wiggleVerifyCandidate`
at `tryOpenLoopShapeDetect`'s deps override); the `notWired(...)` stubs in
`curve-mover.ts`'s `makeCurveLocatorDeps`. `move-to.ts`'s own import of the
`findCursorByShape` *detector function* (from `cursor-shape-detect.ts`) stays —
it's still called directly by `wiggleVerifyCandidate`'s own module-level
implementation (a separate mechanism from the deleted deps member, per the
"intentionally left untouched" comment already in `cursor-locator.ts`).

Stranded 7 `not.toHaveBeenCalled()` assertions in `cursor-locator.test.ts`
that used to pin "the retired shape fallback stayed retired" — replaced with
one source-grep test (style of `no-fifth-slam-copy.test.ts`) asserting
`cursor-locator.ts` contains no `findCursorByShape(` call, so the retirement
decision survives losing its old enforcement vehicle.

## Consequences

`CursorLocator`'s `LocateProfile` union is now exactly the three profiles
with real callers — `grep`ing for `locate(...,'<profile>',...)` across
`src/pikvm/*.ts` (excluding tests) will always find at least one real
non-test call site for every profile in the union. If a future profile is
added speculatively (ahead of its intended caller landing), track that
explicitly rather than letting it sit unreferenced indefinitely — this ADR
is the second time speculative-but-never-wired locator scaffolding needed a
cleanup pass.
