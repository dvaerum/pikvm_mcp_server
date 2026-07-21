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

---

## Overall order & finish

```
C1 P1 (offline) → C1 P2 (bench) → C1 P3 origin (bench) → C1 P3 verify (bench)
→ C1 P3 openLoopShape (bench) → C1 P3 curve (bench) → C2 P1 (bench) → C2 P2 (offline)
```

**Final step (only after ALL of the above is implemented AND live-verified):**
`git rm docs/plans/cursor-locator-and-mover-collapse.md`, commit ("chore: remove
completed hand-off plan"), and push. This doc is ephemeral.
