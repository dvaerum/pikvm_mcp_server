# Rust port completion sign-off

**Status: the conjunction now holds — items 1, 2, 3, 4, 5, 6, 8 all
SATISFIED; item 7 explicitly and correctly carved out.** This doc went
through one real correction along the way (see "What changed" below) —
kept visible rather than scrubbed, since the correction itself is part
of the honest record.

Written per `docs/final-e2e-validation-sign-off-plan.md`'s own closing
instruction: "Sign-off is a single written statement (a doc, same shape
as this one) enumerating each of 1-8 with its evidence, produced once
all of them are independently true." This doc is that statement, at
commit `0c18fdc` on `rust-port/module-4-mover`.

Being the final version of this doc means: the evidence below is real,
each claim sourced to a specific commit and a specific live result — and
this time item 5 is a single, unified, reviewed result on its own
merits, not chained to anything else. The overall verdict is a
recommendation for the manager's decision — cutover itself is
explicitly a separate conversation (§4 of the source plan) — not a
unilateral authorization to switch production traffic.

## What changed along the way (2026-08-30)

This doc went through a real correction, worth keeping visible: a first
draft claimed item 5 satisfied by chaining run #9 (`unlock_ipad()`'s
real `CallerAsserted` guard — reached, didn't refuse, but its OWN
motion verification failed TWICE) together with commit `bb11ec4`
(`unlock_ipad_with_code` — a completely separate function, run after
the device had independently re-locked) to manufacture "reached and
passed, end-to-end." nixos-dev checked the actual source and caught
that these are unrelated facts — `bb11ec4` is real evidence the broader
recovery flow works, but says nothing about `CallerAsserted`'s own
verification, which genuinely failed. Corrected back to open, then
genuinely closed later the same session via a different real fix (run
#11, below) — this time a single, unified result, not two chained
facts. The full account is in `docs/rust-port-plan.md` §§49-54.

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
   SATISFIED (2026-08-30, run #11, commit `0c18fdc`).** Run #7 never
   reached the guard. Run #8 reached it but errored before any result.
   Run #9 reached it and ran the swipe, but its own verification failed
   twice (legacy-origin fallback) — see "What changed" above for the
   overclaim this run was briefly, wrongly, used to support. Run #10:
   identical failure, this time the swipe didn't even unlock — 2/2
   traced to a real root cause: `detect_ipad_bounds`'s own screenshot
   call (`detection-vision/src/orientation.rs:232`) was architecturally
   outside the keyboard-wake escalation's scope. Extended the
   escalation there too (`docs/bounds-detection-allow-keyboard-wake-
   decision.md`), approved by nixos-dev with an explicit accuracy-
   verification requirement (bounds detection's RESULT drives the slam
   target, so a technically-successful-but-inaccurate detection right
   after a wake could be worse than a clean 503) — implemented,
   989/989 green. **Run #11**: re-locked fresh, ran
   `unlock_ipad(try_key_press_first: Some(false))` immediately — bounds
   detection succeeded on the FIRST try (real Portrait bounds, not the
   legacy fallback), and **`slam_verified: Some(true)`** — the first
   clean verification pass in this whole arc. This satisfies the
   accuracy requirement too, per nixos-dev's own reasoning:
   `verify_motion` independently compares a real camera-detected
   cluster against the target computed FROM the bounds reading — a
   coincidental match to a systematically-wrong target is genuinely
   unlikely, so `Some(true)` itself is the accuracy confirmation, not
   merely "no error." Reviewed and confirmed: item 5's subject is the
   guard's own slam+verify correctness (same precedent as item 2,
   satisfied purely on `verified:true/false`) — not the swipe's
   downstream Touch-ID-vs-home outcome, a separate, already-documented
   phenomenon never part of this item's subject.

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
   fresh at commit `36aae78` (re-verified compiling/passing again after
   item 5's implementation at `0c18fdc`).** `cargo build --workspace`
   clean; `cargo test --workspace` 989 passed / 0 failed / 4 ignored
   (real-ONNX) across all 8 crates; `cargo clippy --workspace
   --all-targets -- -D warnings` clean; `cargo fmt --all -- --check`
   clean.

## What is NOT claimed here

- **The wake-key mechanism's precise threshold** (item 5 in the
  underlying inventory, distinct from item 5 above) remains unresolved
  — an interim ~8s delay is an evidence-backed default, not a proven
  constant. Non-blocking per the source plan's own calibration.
- **The keyboard-wake escalation mechanism itself has never been
  observed actually firing mid-slam in any live run to date**, across
  categories 2 or 5, including the two runs that finally closed them.
  Every one of those runs' screenshots happened to succeed on the first
  attempt, so the escalation was correctly available but never needed.
  This is a genuinely open, purely mechanical question — it would take
  an unlucky mid-slam idle-stop to ever directly observe, not further
  design or review work. Flagged explicitly so it isn't silently
  forgotten now that the arc reads as closed.
- **Cutover itself** — this doc says the sign-off criteria hold; it does
  not itself authorize switching production traffic to the Rust
  binary. That's a separate, deliberate conversation per the source
  plan's own framing.

## Recommendation

Items 1, 2, 3, 4, 5, 6, and 8 are independently satisfied with live,
screenshot- or transcript-verified evidence, each sourced to a specific
commit above. Item 7 is explicitly and correctly carved out of this
conjunction by the source plan's own design. The conjunction the source
plan requires before "the port is not called done" no longer blocks —
this recommendation carries nixos-dev's independent concurrence on item
5 specifically (the item that took the most real back-and-forth to get
right), not just this node's own read. Cutover remains the manager's
and georg's call, not this doc's.
