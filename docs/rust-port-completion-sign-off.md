# Rust port completion sign-off (DRAFT)

**Status: DRAFT, for nixos-dev review before this is treated as final.**
Written per `docs/final-e2e-validation-sign-off-plan.md`'s own closing
instruction: "Sign-off is a single written statement (a doc, same shape
as this one) enumerating each of 1-8 with its evidence, produced once
all of them are independently true — not asserted from memory of
individual PASSED messages scattered across the session." This doc is
that statement, at commit `68d4749` on `rust-port/module-4-mover`.

This being a DRAFT means: the evidence below is real and each claim is
sourced to a specific commit and a specific live result, not asserted
from memory — but the overall verdict ("the conjunction holds") is a
proposal for nixos-dev + the manager to confirm, not a unilateral
declaration. Cutover itself is explicitly a separate conversation (see
§4 of the source plan) — this doc only speaks to whether the sign-off
criteria that gate that conversation are met.

## The eight items, per `docs/final-e2e-validation-sign-off-plan.md` §2

1. **Paired iPadCollector ground-truth bench — SATISFIED.** Commit
   `a55685a`. N=20, zero WS reconnects, zero missing-ground-truth
   trials, 19/20 within the established 5.9px tolerance, 1/20
   marginally over (6.245px, noise-floor territory, visually confirmed
   as a real close correct landing).

2. **`cornerTargetFromBounds`/anchor-verification positive+negative
   control — SATISFIED.** Run #7 (2026-08-30) completed the full
   guarded slam pair end-to-end: positive `verified:true` (real corner
   landing), negative `verified:false` (real short slam correctly not
   matched), clean recovery, exit 0, zero incident. Honest caveat: the
   wake-nudge escalation itself never needed to fire this run (every
   screenshot succeeded on its first attempt) — this satisfies the
   control-pair criterion as literally worded, but is not itself live
   evidence for the escalation mechanism.

3. **HID recovery / #51 stale-settle-latch — SATISFIED.** Commit
   `17b918e`. Forced a real `POST /hidmode` mode switch; gate
   auto-released after 15075ms with no `clear_settling()` call and no
   process restart, matching the #51 incident's exact failure shape. A
   cleanup-path robustness gap in the harness's own restore step was
   found and documented (not a defect in the mechanism under test,
   which passed cleanly).

4. **PR93 cascade hint-narrowing — SATISFIED** (technically §8 items
   9-10 in the source plan's inventory, folded into this list per the
   plan's own framing). No-hint 1305ms baseline; good hint 151ms/2.2px
   drift; bad-hint negative control correctly falls back to full scan
   and still finds the real cursor. Real-MCP-transport gate
   (`pikvm_mouse_move_to`/`click_at`) also SATISFIED: landed 10.8px from
   target over the real spawned binary's real stdio JSON-RPC transport,
   visually confirmed.

5. **`ipad_unlock.rs`'s `CallerAsserted`-on-lock-screen positive path —
   SATISFIED (2026-08-30).** Two real attempts (#7, #8) established the
   guard was reachable but didn't produce a verified result. Run #9
   (commit `b8fc3d9`), after landing the `unlock_ipad`-internal-slam
   keyboard-wake escalation extension (`bd4c448`), ran the guard all the
   way through a real swipe — landed on the Touch ID/passcode prompt,
   not home (a known, already-documented escalation pattern, not a
   failure). Completion (commit `bb11ec4`, manager-approved use of the
   already-established stored-passcode credential path): a fresh,
   purely-passive screenshot confirmed the device had re-locked to the
   plain lock screen; `unlock_ipad_with_code` against that confirmed
   state produced a real, screenshot-confirmed genuine home screen.
   Reached AND passed, live, end-to-end.

6. **The stationary-guard widening
   (`would_reject_as_stationary` K=4 ring) — SATISFIED (2026-08-30,
   commit `00af531`).** Three organic live attempts were inconclusive
   (real detector cascade run-to-run variance too high to reproduce the
   exact scenario by re-running the same target). Per the redesigned
   staged-observation approach (`docs/stationary-guard-staged-
   observation-repro-plan.md`, ordering pinned down by nixos-dev in
   `5921ecc`): real `PiKVMClient`, real HID emit accounting, real
   `would_reject_as_stationary`, staged candidate positions. Result:
   `widened=true, old_equivalent=false` — the widened ring genuinely
   rejects a staged 2-passes-back candidate a bare single-observation
   belief does not.

7. **`task_4b034fc4e018` (it-03400 desktop/absolute + slam-then-move
   gate) — explicitly OUT of this conjunction, by the source plan's own
   §4.** Blocked purely on a physical hardware issue (capture-side
   unavailability) on a different appliance this node has no access to
   — not a code question, not resolvable through more testing or design
   work here. The iPad rig (`pikvm01`) is this project's one confirmed
   real-iPad target and everything in items 1-6 validates that path;
   this item gates only a separate desktop/absolute-mouse cutover
   decision, not the iPad-critical-path one.

8. **Full workspace `cargo build/test/clippy/fmt` green — SATISFIED,
   fresh at commit `36aae78`.** `cargo build --workspace` clean;
   `cargo test --workspace` 989 passed / 0 failed / 4 ignored
   (real-ONNX) across all 8 crates; `cargo clippy --workspace
   --all-targets -- -D warnings` clean; `cargo fmt --all -- --check`
   found one real diff (this session's own new example file), fixed and
   re-verified clean.

## What is NOT claimed here

- **The wake-key mechanism's precise threshold** (item 5 in the
  underlying inventory, distinct from item 5 above) remains unresolved
  — an interim ~8s delay is an evidence-backed default, not a proven
  constant. Non-blocking per the source plan's own calibration.
- **The keyboard-wake escalation mechanism itself has never been
  observed actually firing mid-slam in any live run to date.** Every
  run across categories 2 and 5 had its screenshots succeed on the
  first attempt, so the escalation was correctly available but never
  needed. This is a genuinely open, purely mechanical question — it
  would take an unlucky mid-slam idle-stop to ever directly observe,
  not further design or review work. Flagged explicitly so it isn't
  silently forgotten once this doc is treated as closing the arc.
- **Cutover itself** — this doc says the sign-off criteria hold; it does
  not itself authorize switching production traffic to the Rust
  binary. That's a separate, deliberate conversation per the source
  plan's own framing.

## Recommendation

Items 1, 2, 3, 4, 5, 6, and 8 are independently satisfied with live,
screenshot- or transcript-verified evidence, each sourced to a specific
commit above. Item 7 is explicitly and correctly carved out of this
conjunction by the source plan's own design. On that basis, the
conjunction the source plan requires before "the port is not called
done" no longer blocks — but this is a recommendation for nixos-dev's
concurrence and the manager's decision, not a unilateral declaration
from this node alone.
