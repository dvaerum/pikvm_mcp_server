# `moveToPixel`/`move_to_pixel` absolute-mode fix — design (task_4b034fc4e018)

## 0. What's confirmed, not guessed

Live finding (it-03400, real IT-02634 desktop/absolute-mouse target,
slam-then-move run twice): USB/HID layer healthy (UDC configured,
mickeys emitted consistently, no gadget fault), but three independent
render checks (the tool's own motion-detection correction, manual
visual inspection, a raw pixel-diff) found **zero evidence the cursor
actually moved on screen.** Independently corroborated by georg watching
the same live target through PiKVM's regular web UI at the same time —
the cursor **does** render and move normally through the web UI's own
absolute-mode commands, which rules out a target OS/input-stack quirk
entirely. The bug is in this codebase's own mover logic.

**Root cause, read directly from source, not inferred:**

- `move_to_pixel` (`rust/mover/src/move_to.rs`) has exactly two branches:
  `strategy == CurveOneShot` → `curve_mover`, everything else →
  `legacy_move::move_to_pixel_legacy`.
- `legacy_move.rs`'s own module doc self-describes as "Approximate-
  absolute move-to-pixel for PiKVM targets in **relative mouse mode**
  (mouse.absolute=false, e.g. iPad)" — and that's accurate: its
  calibration probe and correction-loop emission exclusively call
  `emit_chunked` → `client.mouse_move_relative()` →
  `POST /hid/events/send_mouse_relative` (`rust/kvmd-client/src/client/mouse.rs:48-49`).
  Zero `mouse.absolute` branching anywhere in the file.
- Per ADR-0002 (already documented in this codebase, cited by
  `src/index.ts`'s `RELATIVE_MOUSE_GATE` comment): "relative reports
  into an absolute-assembled gadget are accepted by kvmd but never
  delivered" — a **documented silent no-op**. Exactly the observed
  symptom.
- **This is NOT a Rust-specific regression.** `src/pikvm/move-to.ts` (the
  TS original this was faithfully ported from) has the byte-identical
  gap: its own top-of-file doc comment self-describes the same way, and
  grep confirms zero `mouse.absolute`/`mouseAbsolute` branching anywhere
  in its correction-loop/calibration-probe emission path either. The
  Rust port is a faithful, bug-compatible port of a pre-existing TS
  limitation — treated here as a real, currently-shipping production bug
  (TS side), not merely a porting gap, per the manager's framing.
- **The real gap**: `src/index.ts`'s own comments claim this already
  works correctly for desktop targets — `policy.strategy` for
  `mouse.absolute=true` targets resolves to `DetectThenMove` (confirmed:
  `rust/pikvm-mcp-server/src/tools/mouse.rs:452-457`'s
  `policy.strategy` mapping), which routes through this exact
  `legacy_move` path, and the `RELATIVE_MOUSE_NOTE` claims
  `pikvm_mouse_move_to`/`pikvm_mouse_click_at` "already select the
  correct strategy for this mode." Neither claim is backed by any real
  absolute-aware logic. This strongly suggests this exact
  tool+desktop-target combination had simply never been live-tested
  before, in either codebase, until it-03400's run today.
- **`HidPolicy.mouse_absolute: bool` already exists** (`rust/ipad-hid/src/hid_mode/types.rs:94`)
  and is already resolved fresh per-call at every relevant tool-handler
  call site — it is simply never threaded into `MoveToOptions`. Three
  real call sites confirmed via direct read, all with `policy` already
  in scope, none passing `mouse_absolute` through:
  - `rust/pikvm-mcp-server/src/tools/mouse.rs:384` (`mouse_scroll`'s
    positioning move)
  - `rust/pikvm-mcp-server/src/tools/mouse.rs:495` (`mouse_move_to`, the
    primary `pikvm_mouse_move_to` handler)
  - `rust/mover/src/click_at.rs:244` (`click_at`'s own internal
    move-then-verify-then-click move step)

## 1. Design goal

`move_to_pixel` should correctly and safely move an absolute-mode
(desktop) target, using the target's real absolute-positioning HID
capability, instead of silently no-opping via relative mickey emission.

## 2. Approach (manager-endorsed direction: option b)

Absolute-mode positioning does not need any of `legacy_move`'s
machinery — no px/mickey calibration, no iterative gross/linear
correction regimes, no origin-discovery-by-slam. An absolute HID
coordinate maps directly and deterministically to a screen pixel. The
right shape is a much simpler, dedicated **move-absolute-then-verify**
path, not a variant threaded into the existing relative-mode logic.

### 2a. New dispatch branch

`move_to_pixel` (`move_to.rs`) gains a new field on `MoveToOptions`:

```rust
/// Whether the target reports mouse.absolute=true (desktop, dual
/// absolute+relative gadget) — sourced from HidPolicy.mouse_absolute,
/// resolved fresh per-call at the tool-handler layer (same convention
/// already used for forbid_slam_fallback/forbid_slam_on_ipad/
/// chunk_pace_ms). Default false (preserves existing iPad/relative-mode
/// behavior for every existing caller that doesn't set this).
pub mouse_absolute: bool,
```

Dispatch becomes a three-way branch, absolute-mode checked FIRST
(target mode is a hardware fact, not a strategy preference — it takes
priority over `curve-one-shot` vs `detect-then-move`, which are both
meaningless distinctions for genuine absolute positioning):

```rust
pub async fn move_to_pixel(...) -> anyhow::Result<MoveToResult> {
    if options.mouse_absolute {
        return absolute_move::move_to_pixel_absolute(client, target, &options).await;
    }
    if options.strategy == Some(MoveStrategy::CurveOneShot) {
        return crate::curve_mover::move_by_curve_one_shot(...).await;
    }
    legacy_move::move_to_pixel_legacy(client, target, &options).await
}
```

### 2b. New `move_to_pixel_absolute` (new file: `rust/mover/src/move_to/absolute_move.rs`)

1. Call `client.mouse_move(target_x, target_y)` — the existing absolute
   REST endpoint (`rust/kvmd-client/src/client/mouse.rs:24`,
   `POST /hid/events/send_mouse_move?to_x=&to_y=`), already handles
   screenshot-scale-space→screen-space coordinate scaling internally.
2. Brief settle delay (reuse `resolved_options`' existing
   `post_move_settle_ms` default rather than inventing a new constant).
3. Verify: capture an "after" screenshot, run cursor detection near the
   target (reuse the existing template-set/shape-detect machinery —
   `find_cursor_by_template_set`/`find_cursor_by_shape`, already
   imported by `legacy_move.rs`, no new detector needed) to confirm the
   cursor actually rendered near the target. This is deliberately a
   SINGLE check, not an iterative correction loop — absolute
   positioning has no accumulation/drift to correct for; if the single
   absolute move+verify doesn't land, that's a real signal (dead/
   unattached gadget — see task_e96aa0e3bff6 — or a genuinely wrong
   target), not something a relative-style correction loop would fix
   anyway.
4. Return `MoveToResult` in the same shape the legacy/curve paths use
   (`final_detected_position: Some(...)` on verified success, `None`
   on verification failure) — so downstream callers (`click_at.rs`'s
   existing `!policy.mouse_absolute` branches, capture-session
   before/after handling) continue to work unmodified; this function
   only changes HOW the move happens, not the result contract.

### 2b-i. `MoveToResult`'s relative-mode-only fields — explicit, not silently defaulted

**Caught in review (georgs-mac-mini)**: `MoveStrategy` (`move_to/types.rs:8-13`,
`DetectThenMove`/`SlamThenMove`/`AssumeAt`/`CurveOneShot`) has no variant
representing absolute positioning, and `MoveToResult` (`move_to/types.rs:198-231`)
carries several fields that are inherently relative-mode concepts —
`emitted_mickeys`, `used_px_per_mickey`, `chunk_count`, `corrections`,
`diagnostics`. Silently defaulting these (`chunk_count: 0`,
`corrections: vec![]`, `emitted_mickeys: (0.0, 0.0)`) would conflate two
different meanings under one value: "zero relative chunks were emitted"
(a real relative-mode outcome) vs. "the concept of a relative chunk
doesn't apply to this move" (the true absolute-mode meaning). A caller
inspecting `result.chunk_count == 0` couldn't tell which one it's
looking at.

**Fix, folded into this design**:
- Add a real `MoveStrategy::AbsoluteMove` variant. `move_to_pixel_absolute`
  sets `result.strategy = MoveStrategy::AbsoluteMove` — callers (and
  future readers) can branch on `strategy` to know unambiguously which
  regime produced a given result, rather than inferring it from a
  zeroed-out field.
- `move_to_pixel_absolute`'s own doc comment must state explicitly what
  the relative-mode-only fields carry and why, as a deliberate contract,
  not an accidental default:
  - `emitted_mickeys: (0.0, 0.0)` — "not applicable; absolute positioning
    emits zero relative HID reports by design, this is not a measurement
    of anything."
  - `used_px_per_mickey: (0.0, 0.0)` — same rationale, no calibration
    ratio exists for an absolute move.
  - `chunk_count: 0` — "not applicable; the single `mouse_move` call is
    not a 'chunk' in the relative-mode sense."
  - `corrections: vec![]` — "not applicable; this path is single-shot
    move-then-verify, not an iterative correction loop (see §2b step 3)."
  - `diagnostics: vec![]` — same rationale, or optionally one entry
    describing the single move+verify pass, if that proves useful for
    debugging — implementer's call, not load-bearing either way.
  - `passes_since_last_verification: 0`, `bailed_to_best_pass: false` —
    genuinely accurate for a single-shot path (there is no "earlier
    pass" to bail to), not sentinels needing special-case documentation.

### 2c. Thread `mouse_absolute` at all three real call sites

```rust
// rust/pikvm-mcp-server/src/tools/mouse.rs:384 and :495, and
// rust/mover/src/click_at.rs:244 — add to each existing MoveToOptions
// construction:
mouse_absolute: policy.mouse_absolute,
```

Three one-line additions. No other call site constructs `MoveToOptions`
with a resolved `policy` in scope (confirmed via grep) — these three are
the complete set.

## 3. TS-side scope

Per the manager: this is a real, currently-shipping production bug in
`src/pikvm/move-to.ts`, not merely a Rust-port gap — it needs the
matching fix, not just a note. Same shape applies: `moveToPixel` needs
an absolute-mode branch, threaded from `hidModeResolver.policy().mouseAbsolute`
at its own call sites in `src/index.ts` (the TS equivalents of the three
Rust call sites above). Recommend this become its own follow-up PR
against `main` — scoping/reviewing it alongside this Rust design risks
conflating two codebases' review cycles; better to land the Rust fix
first (this is the actively-being-validated port, with a live-hardware
gate ready to re-run), confirm it live, then port the same fix back to
TS with the Rust version as the proven reference implementation.

## 4. Testing plan

- **Unit tests** (new, `rust/mover/src/move_to/absolute_move.rs`'s own
  `#[cfg(test)]` module or a sibling `tests.rs`, mirroring the existing
  `click_at.rs`/`ClickAtDeps` dependency-injection seam so this is
  testable without a real client):
  - `mouse_absolute: true` dispatches to the new absolute path, calls
    `client.mouse_move()`, never calls `client.mouse_move_relative()`.
  - `mouse_absolute: false` (or default/unset) is a complete no-op
    change — existing curve-one-shot/legacy dispatch and all existing
    tests for both remain byte-identical (this is the regression gate
    that proves the fix doesn't touch the iPad/relative-mode path at
    all).
  - Verification-failure path returns `final_detected_position: None`
    rather than silently reporting success.
- **Live-hardware verification gate** (it-03400, real IT-02634 target,
  same setup as the original finding): re-run the exact
  slam-then-move / move-to-pixel sequence that surfaced this bug, three
  independent render checks (motion-detection correction, visual
  inspection, pixel-diff) — this is the real close-the-loop test, same
  standard as every other live-hardware fix this session. This needs
  real hardware access I don't have (OFFLINE-only) — the natural owner
  is it-03400, who ran the original finding.
- **`cargo test/clippy/fmt --workspace`** clean, full cycle, before any
  commit — standing discipline this session.

## 5. Blast radius / risk

- Contained to `move_to_pixel`'s three real call sites (§2c) — no other
  caller constructs `MoveToOptions` with `policy` in scope, so no other
  code path is silently affected.
- `click_at.rs` benefits as a side effect: it already delegates its
  move-then-verify-then-click "move" step to `move_to_pixel`, so once
  `policy.mouse_absolute` is threaded through there too, desktop/
  absolute-target clicks that currently silently fail to move the
  cursor before clicking should be fixed by the same change — worth
  explicitly re-testing `pikvm_mouse_click_at` against a real desktop
  target as part of the live-hardware gate above, not just
  `pikvm_mouse_move_to`.
- Default `false` on the new `MoveToOptions.mouse_absolute` field means
  every existing call site NOT updated in §2c (there are none today,
  but any future one) safely preserves current relative-mode behavior
  rather than silently breaking — a caller has to explicitly opt in by
  having `HidPolicy` resolve `mouse_absolute: true`, which only happens
  for a genuine absolute-mode target.

## 6. `mouse_absolute` trust model — decided (a), caller-supplied unconditionally

Resolved in review (georgs-mac-mini), with a concrete reason beyond
convention-consistency: `policy` is freshly resolved at the TOP of
every handler invocation (`mouse.rs:434`,
`shared.hid_mode_resolver.lock().await.policy()`), never cached or
shared across calls. The staleness window a self-verifying
`get_hid_profile()` call inside `move_to_pixel` would guard against is
already ~zero within the same call chain — it wouldn't systematically
catch anything the caller's own fresh resolution didn't just establish
moments earlier, it would just add a mandatory HTTP round-trip to every
single move for a benefit that's already covered. The real safety net
for "a caller forgot to thread it" is already §5's default-`false`,
which costs nothing and correctly fails toward the safe (relative-mode)
behavior rather than a dangerous silent assumption.

**Decision: (a) — trust the caller-supplied flag unconditionally, no
internal re-verification.**

## Sequencing

1. ~~This doc → review by georgs-mac-mini~~ **Done.** No gaps in root
   cause/blast-radius analysis (independently re-checked against source
   line-by-line, not just the doc). One real gap found and folded in
   above (§2b-i). §6 resolved to (a).
2. Implement §2 (Rust), full test cycle, PR against
   `rust-port/module-4-mover`. **Next step.**
3. Live-hardware verification gate (it-03400, coordinated via
   georgs-mac-mini) — real close-the-loop confirmation before calling
   this actually fixed.
4. Follow-up: scope + land the matching TS-side fix (§3) as its own PR
   against `main`, using the proven Rust implementation as the
   reference.

## What changed

- Initial version: root-cause diagnosis (§0), design (§2), TS-side scope
  note (§3), testing plan (§4), blast radius (§5), open §6 question.
- Revision after georgs-mac-mini's review: added §2b-i (`MoveStrategy::AbsoluteMove`
  variant + explicit sentinel-value documentation for `MoveToResult`'s
  relative-mode-only fields, closing a real gap where silently
  defaulting them would have conflated "zero relative chunks emitted"
  with "the concept doesn't apply"). §6 resolved to (a) — trust the
  caller-supplied flag unconditionally — with the concrete policy-
  freshness reasoning recorded, not just a preference.
