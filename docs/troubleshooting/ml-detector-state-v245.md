> ⚠️ **This doc may assert mechanisms now rejected as unverified.** See [REJECTED_CLAIMS.md](REJECTED_CLAIMS.md) — `pointer-effect snap`, `iPad ignores tap`, `dead zone`, `stuck in dock` are hypotheses, not observed facts. Re-verify before quoting.

# ML cursor detector — state at v0.5.245

**Last updated:** 2026-05-13 (Phase 318 prod ship)

Single-page reference for the ML detection stack shipped 2026-05-13.
Replaces the need to read 8 troubleshooting docs from Phases 314-318
to understand the current detection architecture.

## TL;DR

- **Detection is honest** at v0.5.245. The Phase 310 tautology (ML
  matching icon features as cursor when cursor is elsewhere) is
  rejected by Phase 317 v3 wiggle-verify.
- **Bench infrastructure is honest** at v0.5.245. The Phase 318
  `isLikelyLockScreen` helper aborts cleanly when iPad re-locks
  mid-bench instead of running 10+ minutes of tautology trials.
- **Production click pipeline is honest** at v0.5.245. The Phase 318
  precheck wires lock detection into `clickAtWithRetry` so a click
  on the lock screen fails fast (<500 ms) with a clear error that
  Phase 72 auto-recovery catches.
- **Click rate remains ~0% verifiable target hits.** The detection
  layer is at its ceiling. The remaining bottleneck is upstream:
  iPad pointer-effect snap zone + rate-limited emit pipeline.
  Addressing these needs explicit user direction per past sessions.

## The detection-honesty stack (5 shipped phases)

| Phase | Version | Change |
|-------|---------|--------|
| 315 | v0.5.239 | Home-zone multi-hint via `buildMLHints` (predicted + belief.position + frame-derived home-zone fallback) |
| 316 | v0.5.240 | Default belief bounds in client constructor — prevents off-screen drift during unlock/home swipes |
| 317 v3 | v0.5.243 | `mlWiggleVerify` checks expected post-wiggle position; rejects icon static FPs |
| 318 | v0.5.244 | `isLikelyLockScreen` helper (dock-strip stddev gate) for bench harness |
| 318 prod | v0.5.245 | Precheck in `clickAtWithRetry` — fails fast on lock screen |

Each ships with regression tests. 746/746 tests pass at v0.5.245.

## Architecture

```
moveToPixel
├── ML detector (src/pikvm/cursor-ml-detect.ts) — PRIMARY
│   ├── findCursorByML — single-hint inference
│   ├── findCursorByMLMultiHint — multi-hint, picks highest conf
│   ├── buildMLHints — predicted + belief (if on-screen) + home-zone
│   └── mlWiggleVerify — Phase 317 v3 tautology rejection
└── Shape detector (src/pikvm/cursor-shape-detect.ts) — FALLBACK
    ├── findCursorByShape — connected-component scoring (Phase 257+)
    └── Phase 297 wiggle-verify — radius-8 still-there test

clickAtWithRetry
├── Phase 38 brightness precheck (uniform dark frames → throw)
├── Phase 318 lock-screen precheck (dock-strip stddev → throw)
└── retry loop (up to maxRetries attempts of moveToPixel + click)
```

## Key invariants

1. **No detection is reported without wiggle-verify in the tautology
   range.** ML wiggle-verify fires when `mlProx ≤ 30` (cursor claimed
   on icon = high tautology risk). Shape detector wiggle-verify
   always fires (Phase 297).

2. **belief.position is reliable.** Default bounds (0..4096 × 0..2160)
   in constructor mean predict() always clips. Off-screen drift can't
   happen via accumulated unlock/home emits.

3. **Lock-screen frames cannot produce false "click ✓" results.**
   Production precheck throws before the retry loop. Bench harness
   detects mid-run re-lock and aborts.

## What's still upstream (NOT in detection layer)

- **Click registration**: 5 trials in v0.5.240 multi-target bench had
  cursor dead-on icon (residual ≤ 20 px verified later as tautologies
  via Phase 317 v3 — likely 0 trials genuinely had cursor on icon).
  Even if cursor DOES reach icon, iPad pointer-effect snap zone may
  consume the tap (Phase 310 finding).
- **Emit pipeline rate-limit**: iPadOS clamps long emits; cursor
  doesn't reach far targets. Detection layer correctly reports the
  large residual; doesn't fix it.
- **iPad re-lock between trials**: ~5 min idle re-locks the iPad.
  `unlockIpad` sometimes can't escape deep lock state (observed
  v0.5.244 bench — `dragPx=1500` failed to recover). May need Touch
  ID or different gesture sequence.

These three are mutually independent and each needs its own
investigation, ideally with explicit user direction.

## Bench protocol (v0.5.245)

`test-v241-short-bench.ts settings|books|tv|appstore` (or no arg →
Settings) runs 3 trials with per-trial lock-state guard:

1. Take pre-click screenshot
2. Run `isLikelyLockScreen` on it
3. If locked: attempt re-unlock; if still locked, abort cleanly
4. Else run clickAtWithRetry; save pre/post frames for visual GT

Per-trial wallclock ~70-90s on success, ~10s on abort. 3 trials
× ~80s = ~4 min fits within typical iPad idle window.

For multi-target verification at N=10, run sequentially with
manual unlock between target blocks.

## Verifying detection honesty (no live iPad needed)

`npx vitest run src/pikvm/__tests__/cursor-ml-detect.test.ts` —
buildMLHints unit tests
`npx vitest run src/pikvm/__tests__/isLikelyLockScreen.test.ts` —
6 calibration tests pinning lock detection against captured frames
`npx vitest run src/pikvm/__tests__/isLockScreenRecoveryError.test.ts` —
9 tests pinning Phase 72 auto-recovery regex including new
Phase 318 precheck error

## Don't repeat

- DON'T try to fix click rate by adding more detection layers. The
  detector is at its ceiling. Adding more candidates / scoring
  tweaks won't help.
- DON'T claim a click "✓" without visually verifying the post-click
  frame — screenChanged at large residual is a false positive
  (Phase 87 distinction).
- DON'T extend bench runtime without lock-state guard. iPad re-locks
  after ~5 min idle; running a 10-min bench produces 5 min of
  contaminated trials.
- DON'T add a precheck error message that doesn't match
  `/lock screen|pikvm_ipad_unlock/i` — Phase 72 auto-recovery silently
  stops firing.

## Files

- `src/pikvm/cursor-ml-detect.ts` — ML wrapper + buildMLHints helper
- `src/pikvm/move-to.ts` — ML+wiggle-verify wired into moveToPixel
- `src/pikvm/ipad-unlock.ts` — `isLikelyLockScreen` + unlock primitives
- `src/pikvm/click-verify.ts` — Phase 38 + Phase 318 prechecks
- `test-v241-short-bench.ts` — lock-aware bench runner
- `docs/troubleshooting/2026-05-13-v239-home-zone-multihint.md`
- `docs/troubleshooting/2026-05-13-v240-multitarget-bench.md`
- `docs/troubleshooting/2026-05-13-v240-phase310-tautology-returns.md`
- `docs/troubleshooting/2026-05-13-phase-317-v3-expected-post-wiggle.md`
- `docs/troubleshooting/2026-05-13-phase-317-bench-lock-contamination.md`
