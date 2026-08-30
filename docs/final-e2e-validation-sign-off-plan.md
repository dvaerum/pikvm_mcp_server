# Final full-workspace E2E validation pass — plan + port completion sign-off criteria

**Status: PLANNING ONLY (task_3c68c923c60b).** No execution in this doc.
Written by nixos-dev, sanity-checked by georgs-mac-mini given they own the
hardware-gate side, per georg's request (relayed by the manager) for a
detailed plan before the Rust port can be called done.

## 0. Correction to this task's own starting brief

The task description that spawned this doc states "categories 3 (HID
stale-latch) and 4 (cascade hint-narrowing) + the real-MCP-transport gate
are PASSED." That's only half right — checked directly with
georgs-mac-mini rather than trusted at face value (same discipline as
today's earlier 56-vs-38 tool-count reconciliation):

- Category 4 and the real-transport gate: confirmed PASSED, real evidence
  (`docs/rust-port-plan.md` §8 items 9-10).
- **Category 3 is NOT passed.** `docs/rust-port-plan.md` v20 recorded it
  BLOCKED (wrong URL, 404) — that specific blocker is now resolved
  (georgs-mac-mini has the real endpoint,
  `https://pikvm01.bb.vcamp.dk/hidmode`, session-cookie auth via
  `/api/auth/login`), but `hid_settling_gate_smoke.rs` has never actually
  been run against it. Unblocked, not executed. Treated as its own open
  item below, not folded into the "done" list.

## 1. Inventory — done vs. open, as of 2026-08-29

| # | Category | Status | Evidence |
|---|----------|--------|----------|
| 4 | PR93 cascade hint-narrowing | **PASSED** | `cascade_hint_narrowing_smoke.rs`: no-hint 1305ms baseline; good hint 151ms/2.2px drift; bad-hint negative control correctly falls back to full scan (1106ms) and still finds the real cursor. §8 item 10. |
| — | Real-MCP-transport gate (`pikvm_mouse_move_to`/`click_at`) | **PASSED** | `move_to_click_at_mcp_smoke.rs` against the real spawned binary over real stdio JSON-RPC, landed 10.8px from target, visually confirmed. §8 item 9. |
| 3 | HID recovery / #51 stale-settle-latch | **PASSED** | Run live against the real endpoint (commit 17b918e): gate auto-released after 15075ms with no `clear_settling()` call and no process restart — the #51 backstop holds on real hardware. Real finding: the harness's own best-effort cleanup step (restore-to-original-mode) failed once (500 then several 403s), recovered manually via a plain retry, confirmed behaviorally with a real HID move + screenshot. Documented as a cleanup-path robustness gap for whoever next hardens the harness — not a defect in the mechanism under test, which passed cleanly. |
| 1 | Paired iPadCollector ground-truth bench | **PASSED** | `task_37374b4bce6d`, now complete (commit a55685a). After the showScene redesign (reviewed) plus 2 more real bugs found live (a transient-torn-frame brightness retry; the actual root cause — the scene-source screenshot must be captured BEFORE relaunching iPadCollector, not after, since the app is already foreground showing its own dark idle view by the time a post-relaunch capture runs) — N=20 completed, zero WS reconnects, zero missing-ground-truth trials, 19/20 within the established 5.9px tolerance, 1/20 marginally over (6.245px, noise-floor territory, visually confirmed as a real close correct landing). |
| 2 | `cornerTargetFromBounds`/anchor-verification positive+negative control | **PASSED** | After 6 blocked live attempts (transport gap, see row below) and the fix chain landing, run #7 (2026-08-30) completed the full guarded slam pair end-to-end: positive `verified:true` (real corner landing), negative `verified:false` (real short slam correctly not matched), clean recovery, exit 0, zero incident. Honest caveat, not glossed over: every before/after screenshot succeeded on its FIRST raw attempt this run — `source.online` stayed healthy throughout, so the wake-nudge escalation (keyboard or mouse) never actually fired. This is genuine, real evidence for the guard/slam control pair itself; it is NOT live evidence for the escalation mechanism, which remains untested against a real mid-slam stall (can't be forced deterministically, only waited for). `docs/corner-control-allow-keyboard-wake-decision.md` (commit a66054d). |
| 5 | `ipad_unlock.rs`'s `CallerAsserted`-on-lock-screen positive path | **STILL OPEN (by this item's own literal bar) — genuine forward progress, but a chained-in unrelated result was wrongly counted as satisfying it; corrected after nixos-dev's review** | Checked directly against the real code before reporting either way: `unlock_ipad()` DOES have a real internal `CallerAsserted`-on-lock-screen call site (`unlock.rs:228`, gated behind `slam_first`, default true) — a genuine, reachable production path, not hypothetical. Run #7 didn't reach it. Run #8 reached it but errored out on the `before` screenshot. Run #9 (commit b8fc3d9), after landing the `unlock_ipad`-internal-slam escalation extension (bd4c448): forced the reachable path (`try_key_press_first: Some(false)`) against a visually-confirmed genuine lock screen and ran the guard through for real: bounds detection failed twice (503, outside the approved scope, expected) and fell back to the legacy origin; the internal slam's own before/after screenshots both succeeded on attempt 1/3 (escalation available but not needed to fire); **slam motion verification failed TWICE** (0 clusters within 80px of expected origin, even after a key-sequence retry — a real negative signal on the guard's own verification, not merely "no result"); `unlock_ipad` executed the swipe anyway per its documented advisory-verification behavior, landing on the Touch ID/"Use Passcode" prompt, not home. **Calibration, corrected (nixos-dev caught this, 2026-08-30)**: a first draft of this doc chained in a SEPARATE step (commit bb11ec4, `unlock_ipad_with_code` — a function with ZERO references to `CallerAsserted`/`anchor_cursor`/`AnchorRequest`, run after the device had independently re-locked in the interim) to claim "reached and passed, end-to-end." That was wrong — bb11ec4 is real, valuable evidence that the broader recovery flow reaches home reliably and that run #9 didn't leave the device anywhere unsafe, but it says nothing about `CallerAsserted`'s own verification outcome, which genuinely failed twice in run #9. Precise, honest verdict: real forward progress over run #8 (guard now reaches, doesn't refuse, executes safely instead of erroring), but this item's own literal bar ("reached AND PASSED") is NOT satisfied — verification failed, same non-result-not-a-pass calibration as run #8, now with an additional real data point (an active verification failure, not just an unreached guard) plus a separately-confirmed benign recovery path. The keyboard-wake escalation mechanism itself has STILL never been observed actually firing mid-slam in any live run to date across categories 2 or 5. |
| — | `slam_to_corner` verification-screenshot 503s | **FIX IMPLEMENTED for BOTH the corner-control harness's before AND after screenshots, exercised live in categories 2 (run #7) and 5 (run #9) without error — the escalation itself still hasn't been OBSERVED FIRING** | Blocked categories 2/5's completion; root cause fully understood, fix now landed for both call sites in the sequence that started this whole investigation. Two real findings layered together: (1) a genuine WS-zombie-connection bug in `StreamerKeepalive`, fixed by active Ping/Pong (35e64ba) — real, worth keeping, confirmed NOT the driver of this pattern. (2) The actual cause: the iPad's own display goes properly dark during the long human-confirmation wait (~10.6-10.7s consistently), and ustreamer correctly reports no source until a real redraw — confirmed decisively (a single `Space` through an already-stuck client immediately revives it; a mouse-move nudge does not). Unifies with the wake-key delay-sweep's own earlier finding (short delay escalates to Touch ID, long delay stays clean) — likely the same underlying display timing studied from two angles. **Fix chain, fully implemented**: v1 (mouse-move-only escalation) shipped, then LIVE-DISPROVEN as insufficient; v2 (context-aware keypress escalation, `keyboard_wake_is_safe` timing gate) built, then hardened with a real safety-scope correction (a bare `Space` isn't universally harmless the way a mouse nudge is — could hit an arbitrary unknown UI context anywhere `fetch_snapshot_with_retry` is called) via a new per-call `ScreenshotOptions.allow_keyboard_wake` opt-in gate, default `false` everywhere. First wired to the AFTER screenshot only (`AnchorRequest.allow_keyboard_wake_after`, dfdf18c) — a live attempt then showed the SAME source.online pattern hitting the BEFORE screenshot instead, one step earlier than the fix reached, giving neither positive nor negative evidence on the fix itself (harness's own graceful-degrade caught it cleanly, zero HID near a corner). Extended to `allow_keyboard_wake_before` too (90f444d) after its own explicit safety re-review (same causal argument — no keys/clicks intercede either way — plus one flagged, non-blocking accuracy question: a successful before-escalation wakes the display right before the slam's own corner-detection runs against that freshly-illuminated frame). A cross-shot test confirms the composition is correct by construction: if `before`'s escalation fires a key, `after`'s escalation in the SAME run correctly falls back to mouse (recent-emit timing gate), even with both fields true. Commit 90f444d, mover 355/355 tests. **Not yet live-verified** — that's the next real step for categories 2/5, deliberately separate and not yet timed. |
| — | Wake-key mechanism (`Space`-once wake-without-dismiss) | **OPEN — controlled sweep run, suggestive shape, threshold NOT pinned** | The precondition categories 2/5's combined gate depends on. Original informal experiment (commit c13142e) found a mixed result and a real premise correction (this rig has Touch ID + a working passcode, not no-passcode as assumed) — see prior inventory history. Follow-up controlled sweep (commit 58769ef, interleaved 2s/4s/8s, reviewed design): **d2 (2s) = 2/2 clean B**, **d8 (8s) = 2 clean A after escalation**, **d4 (4s) = 3/3 genuinely inconclusive** (torn capture every attempt, not a guessed value). Shape (short→B, long→A) is consistent with the timing-confound hypothesis but the one value that would have pinned the threshold never resolved. Recommendation: an interim ~8s delay before the wake step's `Space` press is a reasonable default for categories 2/5's retry, but this is NOT a fully proven threshold — a finer sweep (5s/6s/7s) with a longer post-press settle is the next real step if a precise value is ever needed. **Real methodology finding**: `unlock_ipad()`'s own cleanup step can itself escalate a genuine A into Touch ID (B) — a torn screenshot #3 must be reported as inconclusive, never inferred from a later recovery-step screenshot (this affected some of today's earlier informal circumstantial reads, not the sweep's own disciplined per-trial classification, which captures before any recovery runs). |
| — | it-03400 desktop/absolute gate (`task_4b034fc4e018`) | **BLOCKED, separately, not on this pass's critical path** | Physical cable/OTG-enumeration issue on `it-03400` itself — a hardware problem on a different appliance, unrelated to any Rust-port code question. See §4. |

**Also newly surfaced today**: `docs/would-reject-as-stationary-widening-plan.md`
— a real production behavior change to `legacy_move.rs`'s stationary-
lock-in guard, closing the specific bug category 1's own design doc
cites as its motivating example. Reviewed (nixos-dev), implemented
(097e4ec, 5/5 tests including a required convergence-false-positive
regression test). **Three live attempts now, all INCONCLUSIVE on the
specific K=4 mechanism**: (1) a generic `legacy_move_smoke.rs` re-run
surfaced a different, already-known legacy-path weakness (motion-diff
pairing failure) instead. (2)+(3) a deliberately targeted reconfirmation
plan (`docs/stationary-guard-targeted-reconfirmation-plan.md`, reviewed —
reused the exact original bug's target/strategy, added guard-firing
log lines, verified the dock layout hadn't drifted before trusting the
repro) ran twice, both genuine non-events (zero rejections logged either
run, trajectories never got near the original dock-icon cluster — wildly
different calibration ratios, 1.185 vs 4.553, explain why). Stopped at 2
per the "escalate once, don't retry open-endedly" pattern used
throughout today. **Recommended next step, not yet designed**: stage
`CursorBelief` observations directly (or script a HID-emit sequence)
rather than hoping the real detector cascade organically reproduces the
same trajectory twice — the real cascade has too much run-to-run
variance (confirmed twice now) to reliably land on the exact repro
conditions by re-running the same target.

**UPDATE (2026-08-30, commit 00af531): §2 item 6 is now SATISFIED.** The
staged-observation approach this section recommended was designed
(`docs/stationary-guard-staged-observation-repro-plan.md`, reviewed by
both team members, ordering pinned down by nixos-dev in `5921ecc`) and
run live: `widened=true, old_equivalent=false` — the real K=4 ring,
wired to a real client and driven by real HID emit accounting, genuinely
rejected a staged 2-passes-back candidate that a bare single-observation
belief did not. See row 6 in the table above for full detail.

## 2. Explicit sign-off criteria — what must be true before "done"

The port is not called done, and no cutover conversation starts, until
**all** of the following hold. This is a conjunction, not a majority —
one missing category means the port has not re-earned the hardware
confidence the TS original built up incident-by-incident (per
`docs/rust-port-plan.md` §8's own framing: "a green Rust test suite is
necessary, not sufficient").

1. **Category 1 (paired ground-truth) run to completion — SATISFIED**
   (commit a55685a). N=20 completed, 19/20 within the 5.9px tolerance,
   1/20 marginal (noise-floor, visually confirmed correct). No
   disagreement severe enough to warrant escalating to N≥80.
2. **Category 2 positive+negative control pair actually run and passed
   — SATISFIED (2026-08-30).** After 6 blocked attempts and the fix
   chain landing (v1 disproven, v2 built + safety-hardened + extended to
   both before/after shots), run #7 completed the full guarded slam pair
   live: positive `verified:true`, negative `verified:false`, clean
   recovery, exit 0, zero incident. Honest caveat: `source.online`
   stayed healthy the whole run, so the wake-nudge escalation itself
   never fired — this satisfies the control-pair criterion as literally
   worded, but is NOT live evidence for the escalation mechanism, which
   remains untested against a real mid-slam stall.
3. **Category 3 run against the real endpoint — SATISFIED** (commit
   17b918e). Forced a real `POST /hidmode` mode switch, gate released at
   15075ms with no restart, matching the #51 incident's exact failure
   shape. A cleanup-path robustness gap was found and documented (not
   fixed) — doesn't affect this item's own sign-off, since the mechanism
   under test passed cleanly; worth someone hardening the harness's own
   restore step before it's reused unattended.
4. **Category 5's positive path reached and passed — STILL NOT
   SATISFIED after 3 real attempts (corrected 2026-08-30 after
   nixos-dev's review caught an overclaim; see the table row above for
   the full account).** Run #7: never reached the guard. Run #8: reached
   it, errored before any result. Run #9 (commit b8fc3d9): the guard ran
   through for real (didn't refuse, executed the slam safely) but its
   own motion verification FAILED TWICE, and the swipe landed on the
   Touch ID prompt, not home. A first draft of this doc incorrectly
   chained in commit bb11ec4 (`unlock_ipad_with_code` — a wholly separate
   function with no `CallerAsserted`/`anchor_cursor` involvement, run
   after the device independently re-locked) to claim this item was
   satisfied. It wasn't: bb11ec4 is real, valuable evidence that the
   broader recovery flow reaches home reliably and that run #9 left the
   device safe — but it is not evidence about `CallerAsserted`'s own
   verification outcome, which genuinely failed. Same calibration as
   run #8 ("guard reached, didn't refuse" is real positive evidence but
   is NOT "reached and passed"), now with one more real data point: an
   ACTIVE verification failure (not just an unreached guard) plus a
   confirmed-benign separate recovery path. Reachable next step: a run
   where the internal slam's motion verification actually succeeds
   (`slam_verified: Some(true)`) in the same continuous `unlock_ipad()`
   call that reaches home — not yet attempted.
5. **The wake-key isolation experiment run and its outcome incorporated
   — PARTIALLY SATISFIED.** Both the informal experiment (c13142e) and
   the controlled follow-up sweep (58769ef) have run. Outcome: `Space`-
   once is neither cleanly confirmed nor cleanly disproved — short delays
   reliably escalate to Touch ID, long delays reliably don't, but the
   precise threshold is unresolved (the 4s value came back inconclusive
   3/3). This item is satisfied enough to UNBLOCK categories 2/5's retry
   with an interim ~8s delay before the wake step's `Space` press (a
   reasonable, evidence-backed default, not a guess) — full confidence in
   a precise threshold is not required to proceed, only a defensible
   default. A finer sweep remains open as a nice-to-have, not a
   prerequisite.
6. **The stationary-guard widening — SATISFIED (2026-08-30, commit
   00af531).** Three organic live attempts (re-running the natural
   camera-driven correction loop) were all inconclusive — the real
   detector cascade's own run-to-run variance (two attempts' calibration
   ratios differed by 4x) was too high to reliably reproduce the exact
   repro conditions this way. Per the redesigned approach agreed after
   those 3 attempts: staged `CursorBelief` observations directly (real
   `PiKVMClient`, real HID emit accounting via `mouse_move_relative`,
   real production `would_reject_as_stationary` — only the candidate
   POSITIONS were supplied directly rather than extracted from a real
   camera detection; see `docs/stationary-guard-staged-observation-
   repro-plan.md`, ordering pinned down by nixos-dev in `5921ecc`).
   Device confirmed on a genuine, safe lock screen throughout (screenshot
   before and after). Real result: `widened=true, old_equivalent=false`
   — the widened K=4 ring genuinely rejected a staged 2-passes-back
   candidate that a bare single-observation belief (same real code) did
   not. This item is now closed on live evidence, not just the 5 offline
   unit tests.
7. **`task_4b034fc4e018` (it-03400) stays explicitly out of this
   conjunction** — see §4. A cutover decision for the iPad-critical path
   does not need it resolved; a cutover decision for the desktop/
   absolute-mouse path does, and that's called out separately at
   whatever point desktop/absolute cutover is actually discussed.
8. **Full workspace `cargo build/test/clippy/fmt` green — SATISFIED,
   verified fresh (2026-08-30) at commit 36aae78.** Ran directly, not
   trusted from an earlier report: `cargo build --workspace` clean;
   `cargo test --workspace` 989 passed / 0 failed / 4 ignored (real-ONNX)
   across all 8 crates; `cargo clippy --workspace --all-targets -- -D
   warnings` clean; `cargo fmt --all -- --check` found one real
   formatting diff (`stationary_guard_staged_repro.rs`, this session's
   own new example) — fixed via `cargo fmt --all`, re-verified clean,
   committed `36aae78`. This item alone
   is satisfied at any given commit — re-verify again at whatever commit
   is actually being signed off, since the workspace keeps moving.

Sign-off is a single written statement (a doc, same shape as this one)
enumerating each of 1-8 with its evidence, produced once all of them are
independently true — not asserted from memory of individual PASSED
messages scattered across the session.

## 3. Sequencing — parallel vs. dependent

**Categories 1, 2, 3, and item 6 are all now DONE** (§2 items 1, 2, 3,
6 — SATISFIED as of commits a55685a/17b918e/[cat2 run #7]/00af531) — no
longer part of the "what's left to sequence" picture below. **Category
5 is corrected back to OPEN** (2026-08-30, after nixos-dev's review
caught a first-draft overclaim that chained an unrelated function's
result into this item's own verdict — see §2 item 4 for the full,
corrected account): real forward progress (the guard now runs through
safely instead of erroring) but its own motion verification failed
twice and the item's literal bar is not yet met. Also still open: the
wake-key mechanism's precise threshold (§2 item 5, nice-to-have, not a
prerequisite) and the standing, purely mechanical question of whether
the keyboard-wake escalation has ever been observed actually firing
mid-slam (it hasn't, in any live run to date — every run's screenshots
happened to succeed without needing it).

**The wake-key dependency is RESOLVED — step 1 ran twice (informal
experiment + controlled sweep)**:
1. Wake-key isolation experiment — RAN (c13142e) then a controlled
   follow-up sweep — RAN (58769ef): short delays reliably escalate to
   Touch ID, long delays reliably don't, precise threshold unresolved
   (see §1's inventory row) →
2. Categories 2/5's combined gate retry, using the interim ~8s wake-step
   delay: attempted 6 real live times. The wake-key mechanism itself
   was NOT the blocker on any of these 6 — every attempt reached and
   exercised the guard/slam logic successfully. **A NEW, different
   dependency now blocks completion**: `slam_to_corner`'s verification
   screenshots 503 unpredictably (see §1's new transport-gap row), a
   transport-level issue unrelated to the wake-key question. Categories
   2/5 are BLOCKED again, but on a well-characterized issue with a
   candidate fix identified (not on an open question needing more live
   experimentation).

**Independent of everything else in this table**:
- `task_4b034fc4e018` (it-03400) — different appliance, different
  blocker (physical cable), no code or rig dependency on any of the
  above. Do not sequence anything else behind it.

**Cutover discussion itself requires ALL of §2's items 1-5 (and 6 if
applicable)** — no partial cutover on "most categories passed." The one
deliberate exception is item 7 (it-03400), which only gates a
desktop/absolute-specific cutover decision, not the iPad-critical-path
one.

## 4. it-03400 desktop/absolute gate — explicitly not on this pass's critical path

`task_4b034fc4e018` is blocked purely on a physical cable/OTG-enumeration
issue on the `it-03400` appliance itself (confirmed unchanged by
georgs-mac-mini as of this doc) — not a code question, not something
either of us can resolve through more testing or design work. It stays
tracked, stays open, and is explicitly carved OUT of the conjunction in
§2: the iPad rig (`pikvm01`) is this project's one confirmed real-iPad
target, and everything in §2 items 1-6 validates that path. Whoever
eventually resolves the it-03400 cable issue can pick this back up
independently; it should not be allowed to stall a cutover conversation
for the path that IS fully testable today.

## 5. Open questions for the manager, not decided here

- Categories 1 and 3 are now both done — the priority-order question this
  section originally asked is moot, left here only as a historical note.
- None, on reflection: confirmed with georgs-mac-mini (direct grep of
  `slam/motion.rs` and `cursor_anchor.rs` for any
  `CursorBelief`/`would_reject_as_stationary` reference — zero hits) that
  category 2's guard (`corner_target_from_bounds` + `slam_to_corner`'s
  `verify_motion`, invoked from `cursor_anchor.rs`'s `run_slam`) and the
  stationary-widening (`CursorBelief::would_reject_as_stationary`, called
  only from `legacy_move.rs`'s correction-pass motion-diff pairing) are
  different mechanisms on different code paths with zero cross-reference.
  §2 item 6's "independent, non-blocking" call stands for a cleaner
  reason than originally stated here: not "it's independent enough to
  treat that way," but there is no shared code between the two at all —
  category 2's sign-off is not contingent on or informed by the
  widening's status on either side.
