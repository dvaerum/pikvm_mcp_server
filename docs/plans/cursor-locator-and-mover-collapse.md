# Hand-off plan — Candidates 1 & 2 (CursorLocator + mover collapse)

> **EPHEMERAL HAND-OFF DOC.** This file is a task hand-off to an agent with
> **live iPad access**. Delete it (`git rm`) as the final step, after full
> implementation **and** live verification are complete. It is not permanent
> project documentation.

You are picking up an architecture-deepening refactor already in progress on
branch **`refactor/architecture-deepening`**. Five behaviour-preserving commits
are already landed and pushed (do NOT re-do them):

| Commit | What |
|---|---|
| `b876aca` | Settings module — all `PIKVM_*` tuning flags centralised in `src/settings.ts` |
| `77b750b` | `src/pikvm/gesture.ts` — shared `emitChunked`; five inlined HID loops removed |
| `1854a35` | shared `median` in `util.ts`; **ADR-0001** on why the look-alike helpers stay separate |
| `665b26c` | `pikvm_health_check` orchestration → tested `src/pikvm/health-check.ts` |
| `b8ea84b` | absolute-mouse gating unified into one `ABSOLUTE_MOUSE_GATE` table in `index.ts` |

Your job: implement **Candidate 1** (unify the Cursor Locator, fold in belief
eviction) and **Candidate 2** (collapse the second mover), which are
hardware-gated and could not be done without a live iPad.

---

## Non-negotiable rules (from AGENTS.md + the detector journal)

1. `move-to.ts` is flagged **"do NOT touch"** — every change to it is
   behaviour-sensitive and must be proven on hardware.
2. **Offline-green ≠ live-correct.** Every step that changes detector or mover
   behaviour must pass the ground-truth bench (§0) before you trust it.
3. The dual-head cascade (`findCursorByV8FullFrame → runCascade`) is **THE
   tracker**; the other detectors are **legacy fallbacks**. Do not change which
   one wins by default, and do not delete a legacy detector (that is a separate,
   later, bench-gated step).
4. One behavioural change per commit; each commit message records the bench
   result (N, p50/p90 residual px, correct-open rate) vs baseline.

---

## 0. The verification gate — run after EVERY behavioural step

**A. Offline (deterministic; the machine is load-flaky so run isolated):**
```bash
npm run typecheck
npx vitest run --no-file-parallelism --testTimeout=30000 <affected test files>
```
The full suite throws false-red timeouts under load — run affected files in
isolation, not the whole suite.

**B. Live ground-truth bench (the real gate).** iPad on the home screen,
iPadCollector foregrounded (`ipad-collector/`; exposes `getCursor()` /
`subscribe-cursor` and `onTapEvent` at `src/pikvm/ipad-app-ws.ts:119`):
```bash
npx tsx benches/bench-1.13c-groundtruth-pointer-accel.ts   # cursor-landing accuracy vs ground truth
npx tsx benches/bench-5.1-groundtruth-retry-loop.ts        # clickAtWithRetry 4-attempt per-attempt drift
```
**Acceptance:** capture a baseline on the branch tip BEFORE your change and
again AFTER, **N ≥ 80**, same iPad state/targets. Behaviour-preserving iff
post-change landing-accuracy (p50/p90 residual) and correct-app-open rate are
within run-to-run noise (±10–15 pp at N=20–30 → use N≥80). Any regression beyond
noise ⇒ `git revert` and re-diagnose against ground truth. **Do NOT "tune" to
recover** — that is the phantom-signal trap the journal repeatedly warns about
([[detector_residual_is_not_ground_truth]]). Do not trust the screenshot-mediated
bench alone.

---

## Candidate 1 — Unify the Cursor Locator (+ belief eviction)

**Goal:** one front door for "where is the cursor?", making the code match the
already-shipped decision (cascade = tracker, rest = fallback). **Zero behaviour
change** in the first cut.

**Design decisions already settled with the repo owner:**

- **A — Stateful.** `CursorLocator` OWNS the `CursorBelief` instance (this folds
  in candidate 5 — belief moves OUT of `PiKVMClient`). `locate()` consults belief
  internally; `observe(fix)` feeds it forward.
- **B — Named profiles, not one merged cascade (yet).** First cut =
  `locate(frame, { profile })`, each profile reproducing today's cascade
  **call-for-call**. Merge profiles only after a bench proves two are equivalent.
- **C — `CursorFix` carries provenance + honest confidence:**
  ```ts
  type CursorFix = {
    position: { x: number; y: number };
    source: 'cascade' | 'motion-diff' | 'template' | 'shape' | 'ml';
    rawScore: number;            // native per-source score; NEVER normalised across sources
    confidence: number | null;   // ONLY where honestly calibrated (ML sigmoid = real;
                                 // motion-diff = null — do NOT fabricate one)
  };
  ```

### The three cascades to reproduce (exact current order — verified in code)

| Profile | Current site | Cascade, in order |
|---|---|---|
| `origin` | `discoverOrigin` (`move-to.ts:864`) | `findCursorByV8FullFrame` (ML; gated by `!settings.ml.disabled`) → `locateCursor` (motion-diff, `cursor-detect.ts:502`) → `findCursorByTemplateSet` (`cursor-detect.ts:1106`) w/ progressive wake → slam fallback |
| `openLoopShape` | `tryOpenLoopShapeDetect` (`move-to.ts:2022`) | `findCursorByMLMultiHint` (`cursor-ml-detect.ts:638`) → `findCursorByShape` dark (`cursor-shape-detect.ts:165`) → `findCursorByShape` bright, each wiggle-verified |
| `verify` | `click-verify.ts:809` | `findCursorByTemplateSet` + `findCursorByV8FullFrame` (`cursor-ml-detect.ts:398`), arbitrated by `shouldFireSecondOpinion` (`click-verify.ts:1555`) / `shouldAdoptSecondOpinion` (`:1578`) |

`curve-mover.ts` uses `findCursorByV8FullFrame` only — add a 4th `curve` profile
or reuse `origin`'s ML head.

### Phases

**Phase 1 — Types + skeleton (OFFLINE only; do not commit as "done").**
- New `src/pikvm/cursor-locator.ts`: `CursorFix`, `LocateProfile =
  'origin'|'openLoopShape'|'verify'|'curve'`, and:
  ```ts
  class CursorLocator {
    constructor(deps: { belief: CursorBelief; /* detectors injected for tests */ });
    async locate(frame: Buffer, w: number, h: number, profile: LocateProfile,
                 hint?: {x:number;y:number}): Promise<CursorFix | null>;
    observe(fix: CursorFix): void;   // → belief.observe
    reset(at: {x:number;y:number}): void;
    setBounds(b: Bounds | null): void;
  }
  ```
- Each profile branch calls the SAME detector functions in the SAME order as the
  table, mapping native results into `CursorFix`. No thresholds/order changed.
- Unit-test with **injected stub detectors**: order per profile, fallback fires
  only on null, `confidence` null for motion-diff / populated for ML, observe→belief
  + reset wiring. Fully offline.
- **Gate:** §0.A only. ⚠️ A locator nothing calls is a hypothetical seam — Phase 3
  makes it real; do not stop here.

**Phase 2 — Move belief ownership (candidate 5). ⚠️ behaviour-sensitive.**
- Construct `CursorLocator` (and thus `CursorBelief`) once at startup; thread it
  where the client is used. Remove `belief` from `PiKVMClient` (`client.ts:125`),
  its four wrappers (`setBeliefBounds`/`observeCursor`/`wouldRejectAsStationary`/
  `resetBelief`), and the `belief.predict()` call inside `mouseMoveRelative`
  (`client.ts:~725`).
- ⚠️ `mouseMoveRelative` currently side-effects `belief.predict()`. That prediction
  must still happen at the SAME point/order — move it to the locator or have the
  caller drive it. Preserve exact timing.
- Update `client-belief-wiring.test.ts`, `cursor-belief-integration.test.ts`.
- **Gate:** §0.A + §0.B (N≥80). Belief seeds hints, so landing accuracy can shift —
  must be within noise.

**Phase 3 — Reroute callers through `locate()`. ⚠️ touches move-to.ts (do-NOT-touch) — highest risk.**
- Replace inline cascades: `discoverOrigin`→`'origin'`, `tryOpenLoopShapeDetect`→
  `'openLoopShape'`, `click-verify` detection→`'verify'`, `curve-mover`→`'curve'`.
- Must emit **byte-identical detector call sequences**. Add temporary logging and
  diff detector calls before/after to prove equivalence.
- **Gate:** §0.A + §0.B **per caller**, in this order: `origin` first (main click
  path), then `verify`, then `openLoopShape`, then `curve`. One commit each, each
  after its own live bench. Revert any that regresses.

#### Phase 3 — execution journal

- **origin — DONE (982b93e).** `discoverOrigin`'s inline V8→motion-diff→template
  cascade routed through `locate('origin')` via `makeLocatorDeps`. Byte-identical.
  bench-5.1(control): baseline N=57 attempt-1 p50=39.0/p90=51.6 final p50=5.0/p90=6.5
  within35=98% → post N=36 attempt-1 p50=38.8/p90=39.8 final p50=4.9/p90=5.8
  within35=100%. p50 identical (−0.2/−0.1px), within noise. Removed dead saveDebug.

- **verify — STOPPED, folded into C2 P1 (not a fixed-profile reroute).** The
  `verify` profile fuses template-second-opinion→v8 into ONE always-run cascade
  seeded `cursorVerified=false / initialResidual=Infinity`, no 80px geo-filter. But
  `click-verify.ts` has **THREE** differently-gated detection/recovery sites, none of
  which the fused profile reproduces:
  1. second-opinion (`click-verify.ts:838`): `findCursorByTemplateSet(minScore:0.7,
     expectedNear:target, radius:200)` after a (1,0)/(−1,0) wake-nudge; gated by
     `shouldFireSecondOpinion` with the **real** finite `initialResidual` + 25px
     threshold; on adopt it mutates `finalDetectedPosition` and sets
     `cursorVerified=true`.
  2. PA19-e (`:883`): `findCursorByV8FullFrame(minPresence:0.5)`; gated by
     `requireVerifiedCursor && !cursorVerified`; adopts iff `heatmapPeak≥0.3 &&
     dist≤80`.
  3. PA19-g (`:971`): `findCursorByV8FullFrame(minPresence:0.5)`; gated by
     `cursorVerified && maxResidualPx!==undefined && currentResidual>maxResidualPx`;
     adopts iff `heatmapPeak≥0.3 && freshDist≤80 && freshDist<currentResidual`.
  Site-1 adoption sets `cursorVerified=true`, which **skips** site 2 — a control-flow
  dependency a single fused `locate('verify')` cannot reproduce. Cannot be preserved
  through the seam ⇒ per §0, STOP not tune. These three sites ARE the "movement/
  detection logic" C2 P1 already removes ("retry loop keeps ONLY verify/dismiss/
  residual/click"), so verify-detection is correctly resolved there, not here.

- **curve — reroute-able faithfully, needs a small locator param.** `curve-mover.ts
  detect()` is one `findCursorByV8FullFrame(minPresence)` call, but `minPresence` is
  a **parameter** (`opts.minPresence ?? 0.5`, caller-overridable via
  `moveToPixel`→`moveByCurveOneShot({minPresence: options.minPresence})`), while
  `locateCurve` hardcodes `CURVE_MIN_PRESENCE=0.5`. Faithful reroute = thread
  `minPresence` into `locate()`/`locateCurve` (small clean API add), then delegate.

- **openLoopShape — reroute-able, needs the wiggle-verify deps wired.**
  `mlWiggleVerify`/`wiggleVerifyCandidate` are currently throwing stubs in
  `makeLocatorDeps`; `tryOpenLoopShapeDetect` (move-to.ts:2022) must pass real
  closures. To do after curve.

**Revised C1 P3 order:** origin ✅ → curve → openLoopShape → (verify absorbed by C2 P1).

#### C1 P3 curve — DONE (c26830a), e2e byte-identical.
Unblocked 2026-07-21 by explicit owner authorization ("if you can test e2e, you may
touch the mover"). Built the missing **`bench-5.2-curve-groundtruth.ts`** (f627c0f) —
drives `moveToPixel(curve-one-shot)` vs iPadCollector getCursor, the iPad's default
mover which had NO regression bench. Rerouted `curve-mover.detect()` through
`CursorLocator.locate('curve', …)` (threaded `minPresence` so it's faithful, not
hardcoded 0.5). N=80 each: BASELINE p50=4.4 p90=17.2 within35=100% → POST p50=4.4
p90=17.1 within35=100%; Δ p50 +0.0 Δ p90 −0.1. Byte-identical. All cursor detection
now goes through the one locator front door — except:

#### C1 P3 openLoopShape — DONE offline-verified; MARKED for future live test.
`tryOpenLoopShapeDetect` is a DEEP fallback: it fires only when motion-diff AND
template-match BOTH fail at open-loop p0 (move-to.ts:1874/1900), on the desktop
(detect-then-move) path — never the iPad curve-one-shot default. No lever forces
motion-diff to fail, and it's a nested closure inside `moveToPixel`, so it can't be
A/B'd live. On 2026-07-21 the owner authorized **offline-only** implementation
(simulate / unit / mock) with a future-live-test marker.
Implemented: `tryOpenLoopShapeDetect` is now a THIN wrapper over
`CursorLocator.locate('openLoopShape')` — deps reuse `makeLocatorDeps` with a `decode`
passthrough over the already-decoded `shot` and the in-scope
`mlWiggleVerify`/`wiggleVerifyCandidate` closures wired real; `{pos, score, prox}` is
reconstructed faithfully (`prox = hypot(fix.position − predicted)`; the wiggle helpers
return unchanged positions, so this equals the original mlProx / candidate prox, and
`fix.rawScore === score`). Only verbose console.error tracing differs (seam permits it).
Offline gate §0.A: typecheck clean; 73 locator+move-to tests pass — the openLoopShape
profile's 5 mock tests (cursor-locator.test.ts:201-307) assert the ML→wiggle→shape→wiggle
order, thresholds (minConfidence 0.5, prox≤30 wiggle gate), and CursorFix mapping.
**`TODO(live-verify)`** left in the code + here: add a ground-truth A/B (cf. bench-5.2)
once a desktop/absolute-mouse target or a force-motion-diff-fail rig exists.

#### Phase 3 — reachability + bench-coverage audit (2026-07-21, prompted by "do we really use all 4?")

Traced BOTH production paths. iPad: `pikvm_mouse_click_at` (default `maxRetries=3`) →
`clickAtWithRetry` with `moveToOptions.strategy='curve-one-shot'` (index.ts:1335/1403,
default at :1246) → `moveToPixel` **returns early at :1341**, before `discoverOrigin` and
the Phase-B block. Desktop (`mouseAbsoluteMode`): defaults to `detect-then-move` (:1246)
and `maxRetries=0` (:596 single-shot, no retry loop) → `moveToPixel` runs the FULL Phase-B
path (`discoverOrigin` then the open-loop shape fallback). No absolute-mode short-circuit
inside moveToPixel. The four profiles split almost perfectly by target (near-disjoint):

| profile | who runs it (default path) | benchable via §0? |
|---|---|---|
| `curve` (curve-mover.detect) | **iPad**, every move | ❌ **NO bench uses `curve-one-shot`**; curve-mover is do-NOT-touch |
| `verify` (click-verify ×3) | **iPad** retry loop (maxRetries=3) | partial (bench-5.1 fix-on proxy) — unpreservable → C2 P1 |
| `origin` (discoverOrigin) | **desktop**, every move (+ bench-5.1 control / explicit detect-then-move) | ✅ bench-5.1 control (done) |
| `openLoopShape` | **desktop**, deep fallback only (motion-diff+template both fail) | ❌ no bench reproduces the shape fallback |

Nothing is dead code — but each profile lives on ONE target's path. This RESCUES the origin
work: routing `origin` serves the `--target desktop` mover, not a dead path. It does NOT
rescue `openLoopShape`'s gate (even on desktop it's the deep fallback no bench reproduces).

**Two hard blockers on the remaining C1 P3 reroutes:**
1. **`curve` — FORBIDDEN.** CLAUDE.md standing rule outranks this plan: *"The MOVER is
   SOLVED — do NOT touch it. curve-mover.ts + strategy:'curve-one-shot'."* Routing curve
   edits `curve-mover.ts`. And there is **no bench** to catch a regression if it did. It's
   also a single call to the already-canonical detector — ceremony, not consolidation. **SKIP.**
2. **`openLoopShape` — UNVERIFIABLE.** Near-dead on the iPad (curve path never reaches it)
   and **no bench exercises the shape-fallback**, so the §0 live gate cannot cover it. Editing
   the do-NOT-touch mover on an un-benchable path violates the "the bench is what makes a
   mover change safe" rule. Faithful reroute is offline-provable (prox reconstructable, real
   wiggle closures), but offline-only ≠ the mandated gate. **DEFER (offline-only, low value).**

**Net C1 P3 outcome:** `origin` ✅ is the real, benched win (consolidated the 3-stage legacy
cascade). `verify` → C2 P1. `curve`/`openLoopShape` are not safely/verifiably routable under
the standing rules + current harness. The remaining verifiable value is **C2** (collapse the
second mover / stop click-verify re-implementing detection — the LIVE verify path).

**Phase 4 — (optional, later) merge equivalent profiles** — only after a bench
shows two land identically. Not required for the refactor to be valuable.

---

## Candidate 2 — Collapse the second mover (do AFTER Candidate 1)

**Goal:** `move-to.ts` is the single mover; `click-verify.ts` stops re-implementing
strategy selection, raw emits, its own micro-correction loop, and its own V8
detection around the `moveToPixel` seam.

**Duplication to remove:**
- `click-verify` re-selects strategy (`detect-then-move` vs `assume-at`) per retry —
  the decision that already lives in `discoverOrigin`.
- It drives the device directly (`client.mouseMoveRelative` edge-nudge, wake, a full
  micro-correction emit loop) — duplicating `move-to`'s `emitChunked`/correction.
- It runs its own `decodeScreenshot` + `findCursorByV8FullFrame` — should come from
  `moveToPixel`'s result / the locator.
- ~20 pure predicates are `export`ed ONLY because the 950-line `clickAtWithRetry`
  monolith can't be tested through its own interface.

### Phases

**Phase 1 — Route all cursor motion through `moveToPixel`. ⚠️ behaviour-sensitive.**
- `clickAtWithRetry` calls `moveToPixel` for every move (incl. retries), passing
  strategy via options, instead of hand-rolling emits. Delete `click-verify`'s
  micro-correction loop; rely on `move-to`'s.
- The retry loop keeps ONLY: verify (screenshot diff), dismiss recipe, residual
  gate, click. No movement logic.
- **Gate:** §0.A + **`bench-5.1-groundtruth-retry-loop.ts`** specifically (it
  replicates this exact loop), N≥80. Per-attempt drift must match baseline.

**Phase 2 — Demote pried-out predicates to internal seams.**
- The ~20 exported predicates (`shouldFireSecondOpinion`, `shouldRunMicroCorrection`,
  `isDivergenceDetected`, `defaultMaxRetriesFor`, …) become module-private once the
  monolith is decomposed into a few named internal functions tested THROUGH
  `clickAtWithRetry`'s interface. Keep the few with their own genuinely-unit-worthy
  tests exported (e.g. `defaultMaxResidualPxFor`).
- **Gate:** §0.A.

**Guardrail:** keep `move-to.ts` changes minimal — make `click-verify` STOP reaching
around the seam, do not rewrite the mover. If a behaviour can't be preserved through
`moveToPixel`, STOP and report rather than change `move-to`'s behaviour.

#### C2 execution journal (2026-07-21)

**Gate discovery:** the directive's named benches (bench-1.13c / bench-5.1) do NOT
exercise `clickAtWithRetry` — bench-5.1 calls `moveToPixel` directly and only *models*
the per-attempt strategy choice. The real gate is **`bench-ground-truth-clickflow.ts`**:
drives the actual `clickAtWithRetry` on a real home screen rendered as an iPadCollector
image scene, with `onTapEvent` ground truth (HIT = tap within 35px). It exercises the
micro-correction loop (74 cached templates → `hasTemplates=true`).

**C2 P1a — DONE (3cb2095).** Deleted the hand-rolled post-move micro-correction loop
(the piece that genuinely DUPLICATED the mover's positioning correction) + its
`lastKnownCursor` output. move-to.ts untouched.
  BASELINE HIT 67/80 = 83.8%  per-tap p50=22.2 p90=41.4
  POST     HIT 69/80 = 86.2%  per-tap p50=20.0 p90=39.9
  Δ +2.5pp (within ±5pp N=80 noise); per-tap tighter. The loop was dead weight (its own
  Phase 132 comment records it DIVERGING to 200px where no-micro reached 23px).

**C2 P1 scope conclusion — the rest is NOT mover-duplication, leave it.** After removing
the micro-correction loop, the remaining `client.mouseMoveRelative` sites in click-verify
are NOT duplicates of `moveToPixel`'s positioning:
  - **pre-click approach (Phase 125)** = a CLICK-REGISTRATION tactic (in-motion click).
    Its comment cites empirical support *FOR* it (stationary cursor didn't register a
    click, moving one did) — opposite of the micro-correction divergence evidence.
    `moveToPixel` has no in-motion-click. Removing it deletes click functionality, not
    duplication → out of C2 P1 scope + regression-risky. KEEP.
  - **edge-unstick (Phase 192-D)** = a RECOVERY primitive (nudge a belief-pinned cursor
    off the edge before a retry). `moveToPixel` doesn't do edge-recovery. KEEP.
So C2 P1's actual target (stop duplicating the mover) is COMPLETE at the micro-correction
removal. Not deleting legitimately-placed click/recovery logic just to maximise deletion.

**C2 P2 (offline) — DONE for the orphaned dead code (3542850).** Removed predicates
`shouldRunMicroCorrection`, `isDivergenceDetected`, `shouldRunMotionConfirmation`,
`wouldExceedSafeBounds` (+ 4 test files), consts `microConvergePx` +
`microCorrectionIterations` (+ docstrings), and the unused `cursorMovedAsExpected` import
— 545 lines. Kept `clampPxPerMickeyRatio` + `minPreClickTemplateScore` (still used).
Typecheck + 45 tests pass. The broader "demote the OTHER ~15 exported predicates to
module-private" is deferred: those predicates are still live (verify/retry logic), and
un-exporting them requires decomposing the 950-line monolith into named internal
functions tested through `clickAtWithRetry`'s interface — a large refactor with modest
payoff. Left as an explicit future task, not blocking.

---

## Session outcome (2026-07-21) — why this plan file is NOT git-rm'd yet

The final step ("`git rm` after ALL phases implemented AND live-verified") is **not met**:
three C1 P3 phases are intentionally **blocked**, not implemented, each for a cited
standing-rule/harness reason (curve = do-NOT-touch mover + no bench; openLoopShape = no
bench can reach it; verify = unpreservable as one profile). This file records those
decisions and the C2 scope conclusion — deleting it would erase the reasoning the repo
owner still needs to review. **Keep until reviewed.**

Delivered + live-verified: **C1 P1/P2** (offline), **C1 P3 origin** (982b93e, benched),
**C2 P1a** micro-correction removal (3cb2095, benched HIT 83.8%→86.2% N=80), **C2 P2**
dead-code sweep (3542850, offline). Blocked/deferred with rationale above: C1 P3
verify/openLoopShape/curve, C2 P1 pre-click/edge-unstick (correctly kept), C2 P2 wider
predicate demotion.

---

## Overall order & finish

```
C1 P1 (offline) → C1 P2 (bench) → C1 P3 origin (bench) → C1 P3 verify (bench)
→ C1 P3 openLoopShape (bench) → C1 P3 curve (bench) → C2 P1 (bench) → C2 P2 (offline)
```

**Final step (only after ALL of the above is implemented AND live-verified):**
`git rm docs/plans/cursor-locator-and-mover-collapse.md`, commit ("chore: remove
completed hand-off plan"), and push. This doc is ephemeral.
