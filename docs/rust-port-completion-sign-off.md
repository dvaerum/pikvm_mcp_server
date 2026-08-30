# Rust port completion sign-off (NOT YET READY — item 5 reopened)

**Status: the conjunction does NOT currently hold. Item 5 is open.**
This doc was first drafted claiming all 8 items satisfied; nixos-dev's
review (real pushback, not a rubber stamp) caught that item 5's
"SATISFIED" verdict wrongly chained a separate, unrelated function's
result into `CallerAsserted`'s own outcome. Corrected below — see the
"What changed" section. Kept as a live tracking doc rather than deleted,
since items 1, 2, 3, 4, 6, and 8 genuinely are satisfied and that
evidence stands; only item 5 needs another real attempt before this can
honestly say "done."

Written per `docs/final-e2e-validation-sign-off-plan.md`'s own closing
instruction: "Sign-off is a single written statement... produced once
all of them are independently true." Since that's not yet true, this
doc cannot yet serve as that statement — it's a status report on how
close the conjunction is, with one item still genuinely open.

## What changed (2026-08-30, post nixos-dev review)

The first draft's item 5 claimed "reached AND passed, live, end-to-end"
by combining run #9 (`b8fc3d9` — `unlock_ipad()`'s real `CallerAsserted`
guard: reached, didn't refuse, executed the slam safely, but its OWN
motion verification failed TWICE, real outcome was the Touch ID prompt,
not home) with commit `bb11ec4` (`unlock_ipad_with_code` — a completely
separate function with zero `CallerAsserted`/`anchor_cursor`/
`AnchorRequest` involvement, run after the device had independently
re-locked). nixos-dev checked the actual source and found these are
unrelated: `bb11ec4` is real, valuable evidence that the broader
recovery flow reaches home reliably and that run #9 left the device
safe — but it says nothing about `CallerAsserted`'s own verification
outcome, which genuinely failed. This is exactly the "uniform phrasing
over non-uniform evidence reads as rigour and isn't" failure mode
flagged elsewhere in this project's own standing rules — caught here by
a real second reviewer rather than shipped uncorrected.

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
   STILL OPEN (corrected 2026-08-30).** Two real attempts (#7, #8)
   established the guard was reachable but didn't produce a verified
   result. Run #9 (commit `b8fc3d9`), after landing the
   `unlock_ipad`-internal-slam keyboard-wake escalation extension
   (`bd4c448`), ran the guard all the way through a real swipe — but its
   own motion verification failed TWICE, and it landed on the Touch
   ID/passcode prompt, not home. Separately, commit `bb11ec4`
   (`unlock_ipad_with_code`, an unrelated function, run after the device
   independently re-locked) confirmed the broader recovery flow reaches
   home reliably and that run #9 left the device safe — real and valuable,
   but not evidence about `CallerAsserted`'s own verification outcome.
   Same calibration as run #8 ("guard reached, didn't refuse" is real
   positive evidence but is NOT "reached and passed"), now with one more
   data point: an ACTIVE verification failure, not just an unreached
   guard. **Run #10**: re-locked fresh (screenshot-confirmed), re-ran
   immediately — identical failure shape, this time strictly worse (the
   swipe didn't unlock at all). Root cause now precisely traced:
   `detect_ipad_bounds` (`detection-vision/src/orientation.rs:232`)
   calls `client.screenshot(None)` — its own screenshot is
   architecturally outside the keyboard-wake escalation's scope by
   original design, so a flaky `source.online` there forces a
   legacy-origin fallback that isn't accurate enough. 2/2 identical
   failure. **Real next candidate fix, not yet reviewed or built**:
   extend the escalation to bounds detection's own screenshot call.

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

Items 1, 2, 3, 4, 6, and 8 are independently satisfied with live,
screenshot- or transcript-verified evidence, each sourced to a specific
commit above. Item 7 is explicitly and correctly carved out of this
conjunction by the source plan's own design. **Item 5 is not yet
satisfied** — real forward progress this session (the guard now runs
through safely instead of erroring, per run #9), but its own
verification failure means the literal bar isn't met. The conjunction
therefore does NOT yet hold, and this doc should not be read as "the
port is done" until a run produces a verified positive result for item
5 specifically. Six of eight items being solid, real, independently-
verified evidence is itself worth recording honestly as progress — it
is not the same claim as completion, and this doc now says which one it
is.
