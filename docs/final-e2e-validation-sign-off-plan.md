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
| 3 | HID recovery / #51 stale-settle-latch | **OPEN — unblocked, not executed** | Real endpoint now known; `hid_settling_gate_smoke.rs` not yet run against it. Lower-risk than 2/5 (disruptive but not a lock/slam sequence). |
| 1 | Paired iPadCollector ground-truth bench | **OPEN — design only, zero execution** | `task_37374b4bce6d`. Design plan written today (`docs/ipad-collector-ground-truth-bench-plan.md`), under review as of this doc. Real new infra (a WS server this process hosts on port 8767). |
| 2 | `cornerTargetFromBounds`/anchor-verification positive+negative control | **OPEN — partial live evidence, PAUSED** | Guard-refusal proven; a genuine short-slam-through-the-guard `verified:false` control has not yet been reached cleanly. Two real incidents (guard-bypass, then guard-on-wrong-precondition) fixed and reviewed; combined run paused 3x on an unrelated wake-key question (see category 5). |
| 5 | `ipad_unlock.rs`'s `CallerAsserted`-on-lock-screen positive path | **OPEN — partial live evidence, PAUSED** | Same combined run as category 2. Safety boundary held 3/3 real attempts (fail-closed correctly every time, zero unsafe HID at any corner); the actual positive path (reach a plain lock screen, then a guarded slam) has never been cleanly reached. Blocked on the wake-key question below, not on the guard/slam logic itself, which is believed sound. |
| — | Wake-key mechanism (`Space`-once wake-without-dismiss) | **OPEN — isolation experiment designed, not run** | The precondition categories 2/5's combined gate depends on. 3/3 live attempts today escalated to a Touch ID/passcode prompt instead of the expected plain-lock-screen state, regardless of starting state. Design for an isolated experiment exists (`docs/wake-key-isolated-experiment-plan.md`), explicitly NOT to run until a genuinely fresh session (rig is being deliberately rested after today's real, sustained live-hardware contact: multiple slams, many key presses, one passcode recovery, three Touch-ID escalations — all recovered cleanly, zero unsafe HID, but real wear on a rig with a documented Touch-ID-lockout pattern under heavy testing). |
| — | it-03400 desktop/absolute gate (`task_4b034fc4e018`) | **BLOCKED, separately, not on this pass's critical path** | Physical cable/OTG-enumeration issue on `it-03400` itself — a hardware problem on a different appliance, unrelated to any Rust-port code question. See §4. |

**Also newly surfaced today, not yet reviewed/scoped for execution**:
`docs/would-reject-as-stationary-widening-plan.md` — a real production
behavior change to `legacy_move.rs`'s stationary-lock-in guard, closing
the specific bug category 1's own design doc cites as its motivating
example. Currently under critical review (nixos-dev), explicitly scoped
to the Rust port's legacy (non-`curve-one-shot`) path only. Tracked here
because its own "done" bar includes a live-hardware re-run of
`legacy_move_smoke.rs`, which touches the same rig as everything else in
this table — sequencing note in §3.

## 2. Explicit sign-off criteria — what must be true before "done"

The port is not called done, and no cutover conversation starts, until
**all** of the following hold. This is a conjunction, not a majority —
one missing category means the port has not re-earned the hardware
confidence the TS original built up incident-by-incident (per
`docs/rust-port-plan.md` §8's own framing: "a green Rust test suite is
necessary, not sufficient").

1. **Category 1 (paired ground-truth) run to completion**, N≥20 per its
   own design doc's negotiated floor, with a stated per-trial tolerance
   (starting point: the established 5.9px detected→tap bias as the noise
   floor) and every disagreeing trial's screenshot saved and inspected.
   Escalate to N≥80 only if the first N≥20 shows real disagreement worth
   characterizing further.
2. **Category 2 positive+negative control pair actually run and passed**
   on the guarded path (`anchor_cursor` with a real `CallerAsserted`
   asserted against a genuine, screenshot-confirmed lock screen) —
   `verified:true` for a correct-corner landing, `verified:false` for a
   deliberately-short slam, both through the guard, not the raw
   primitive.
3. **Category 3 run against the real endpoint** — force a real
   `POST /hidmode` mode switch, confirm the mover gate releases within
   the expected window without a process restart, matching the #51
   incident's exact failure shape.
4. **Category 5's positive path reached and passed** — a genuine
   `CallerAsserted`-on-lock-screen run through `unlock_ipad()`/
   `ipad_go_home()`'s real production call sites, not an isolated
   synthetic smoke test.
5. **The wake-key isolation experiment run and its outcome incorporated**
   — either confirms `Space`-once as reliable (categories 2/5 can retry
   the combined gate as originally designed), or disproves it (the
   combined gate's design changes to default to the mouse-move fallback
   instead of retrying the same assumption a 4th time).
6. **If the stationary-guard widening (`would-reject-as-stationary-
   widening-plan.md`) is implemented before sign-off**, its own live
   gate (a re-run of `legacy_move_smoke.rs` or equivalent, confirming the
   specific 2-passes-back stale-repeat bug no longer reproduces) must
   also pass. If it is NOT implemented by the time everything else above
   is done, that's an acceptable state to sign off in — it's a
   documented pre-existing reliability gap in an already-lower-priority
   path (`legacy_move.rs`, not `curve-one-shot`), not a NEW regression
   introduced by the port. Flag it as known-open in the sign-off, don't
   let it silently block everything else.
7. **`task_4b034fc4e018` (it-03400) stays explicitly out of this
   conjunction** — see §4. A cutover decision for the iPad-critical path
   does not need it resolved; a cutover decision for the desktop/
   absolute-mouse path does, and that's called out separately at
   whatever point desktop/absolute cutover is actually discussed.
8. **Full workspace `cargo build/test/clippy/fmt` green** at the commit
   being signed off, verified fresh (not trusted from an earlier report)
   at sign-off time, matching the standing per-commit discipline already
   applied throughout this port.

Sign-off is a single written statement (a doc, same shape as this one)
enumerating each of 1-8 with its evidence, produced once all of them are
independently true — not asserted from memory of individual PASSED
messages scattered across the session.

## 3. Sequencing — parallel vs. dependent

**Can run in parallel, no ordering constraint between them**:
- Category 1 (paired ground-truth) — new infra, independent of
  categories 2/3/5's rig state.
- Category 3 (HID mode-switch gate) — disruptive to the HID session but
  not a lock/slam sequence; doesn't touch the same risk surface as
  categories 2/5. Lower-risk, could reasonably go FIRST among the open
  hardware items given it's fully unblocked and just needs building.
- The stationary-guard widening's implementation + offline tests (not
  its live gate) — pure code, no rig contact needed until the live
  re-run step.

**Must run in this order (hard dependency)**:
1. Wake-key isolation experiment (small, low-risk, 3-5 trials) →
2. Categories 2/5's combined gate retry (depends entirely on (1)'s
   outcome — either retry as-designed or redesign the wake step first).

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

- Priority order among categories 1/3 (both fully open, both
  parallel-safe, both need someone to actually build+run them) — whoever
  picks these up next, which first?
- Whether the stationary-guard widening should be treated as a
  prerequisite for calling category 2's live gate "representative" (it
  touches the same correction-loop code category 2's guard sits inside),
  or is genuinely independent enough to land on its own schedule as §2
  item 6 assumes.
