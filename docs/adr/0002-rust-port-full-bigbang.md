# Port pikvm-mcp-server to Rust — full port, big-bang strategy

## Status

accepted (2026-08-28)

## Context

`docs/rust-port-plan.md` (task_721cb397235a) investigated whether a Rust
port would improve the measured Pi4 performance problem (13-27s/move,
already substantially fixed separately via PR93's cascade hint-narrowing,
task_484bed055820). That investigation — three rounds of real critical
review with nixos-dev, independently re-verified rather than rubber-stamped
— concluded **no**: the dominant cost is inference time, already native
code (`onnxruntime-node`) regardless of host language, so a rewrite of the
TypeScript orchestration layer cannot make it faster. That performance
analysis is correct and this decision does not overturn it.

Georg has nonetheless decided to proceed with a full Rust port, on
**preference and maintainability grounds — explicitly not performance**.
This ADR records that decision so it isn't re-litigated cold in a future
session (the pattern ADR-0001 exists to prevent, applied here to a much
larger decision): a future reader should not find this port and assume it
was chased for speed, nor propose reverting it because the speed case
doesn't hold — the speed case was never the reason.

## Decision

**Port the full codebase to Rust.** Strategy: **big-bang** — build the
complete Rust implementation as a parallel effort, validate it with multiple
rounds of real E2E testing (see §8 of `docs/rust-port-plan.md` and the
module-by-module plan's own validation tasks) before cutover, rather than an
incremental in-place migration.

**Why big-bang over incremental**, for the record: this codebase's hardest
bugs (this session's own N1 mover-correction-loop dead-exit, the
cornerTargetFromBounds P0, several HID-recovery incidents) were all found
through *behavioral* hardware testing, not code review — an incremental
port that ships partially-Rust, partially-TypeScript code paths would need
to maintain two parallel implementations' worth of that hard-won correctness
simultaneously, and would make it genuinely ambiguous which language's code
path a live hardware finding applies to. A big-bang build-then-validate
sequence keeps that ambiguity from ever existing: the TypeScript
implementation remains the single source of behavioral truth (and stays in
production) until the Rust implementation has independently earned the same
confidence via its own real hardware validation, then cutover is a single,
clean, well-tested swap — not a long period of split-brain behavior.

**Library-first**: use mature, established Rust crates instead of
hand-rolling infrastructure wherever one genuinely exists and fits. See
`docs/rust-port-plan.md` §6 for the concrete crate evaluation.

## Consequences

- The existing TypeScript codebase (19,083 non-test LOC, 1240 tests) remains
  the production implementation and the single source of behavioral truth
  until the Rust port passes its own E2E validation (§8) — no partial
  cutover, no dual-maintenance period.
- The performance analysis in `docs/rust-port-plan.md` §§1-5 stays valid and
  should NOT be cited as a reason to abandon or deprioritize this port —
  it answers a different question (does this help speed) than the one this
  ADR answers (should we do it for other reasons). Conversely, this ADR
  should not be read as retracting that performance analysis.
- A full rewrite carries real, demonstrated risk of reintroducing already-
  fixed, hard-won bugs (§3's concrete examples: `TAUTOLOGY_PROX_THRESHOLD`,
  `HEATMAP_FLOOR`, `HINT_WINDOW_RADIUS_PX`, and the incidents behind them).
  The E2E validation plan (§8) exists specifically to re-earn that
  correctness on the Rust side before cutover, not to assume porting the
  code also ports the behavioral guarantees.
- Effort is real and multi-month (§3); this ADR does not estimate a
  timeline — see the module-by-module technical plan's own per-unit
  estimates for that.
