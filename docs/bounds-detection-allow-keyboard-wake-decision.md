# Opt-in decision: `allow_keyboard_wake` for bounds-detection's own screenshot call (2026-08-30)

**Status: DRAFT, for nixos-dev review before implementation.**

## What's being decided

Whether to extend the v2 wake-nudge escalation's per-call consent
(`ScreenshotOptions.allow_keyboard_wake`) to the screenshot call inside
iPad bounds detection (`detect_ipad_bounds`,
`detection-vision/src/orientation.rs:232`), which currently hardcodes
`client.screenshot(None)` — i.e. `ScreenshotOptions::default()`,
`allow_keyboard_wake: false`, unconditionally, at every call site.

## Why this matters now (real, live evidence, not speculation)

Two consecutive live attempts at category 5's positive path (run #9,
run #10 — `docs/rust-port-plan.md` §§49/52) hit the identical failure
shape: bounds detection 503'd (the same `source.online` idle-stop
pattern this whole arc has been fixing elsewhere), fell back to
`LAST_GOOD_BOUNDS`/the legacy origin, and that fallback wasn't accurate
enough for the subsequent slam's own motion verification to succeed —
in run #10, not even for the swipe itself to register as a valid
unlock gesture. This is a real, reproducible (2/2) blocker on the one
sign-off item still open, not a hypothetical gap.

## Two distinct call sites — each needs its own causal analysis

Unlike the two already-approved sites (which were each a single,
identifiable screenshot call), bounds detection is reached from TWO
separate places with DIFFERENT pre-histories, and a shared helper
function serves callers with different safety properties. Each is
analyzed separately below — flattening them into one blanket "bounds
detection is always safe to escalate" claim would repeat the exact
"uniform phrasing over non-uniform evidence" mistake nixos-dev caught
in this session's category-5 write-up.

### Site A: `unlock_ipad`'s own bounds-detection call (`unlock.rs`, `detect_bounds_or_null(client, ..., "ipad-unlock")`)

Reached only when the function does NOT take its early-return branch —
i.e. either:
- `try_key_press_first == Some(false)` (the key-press-first branch is
  skipped entirely), **zero keys sent this call up to this point** —
  same clean causal shape already approved for the internal-slam
  extension (`bd4c448`), or
- `try_key_press_first` unset/`true` AND the key-press attempt itself
  returned `Err` (`run_key_sequence(...).is_ok()` was false) — in this
  case **a real key (Esc, and possibly Enter/Space depending on how far
  the sequence got before erroring) WAS already sent this call**,
  before bounds detection runs.

These are genuinely different situations. **Recommend gating on
`try_key_press_first == Some(false)` specifically** — the exact same
condition already used for `allow_keyboard_wake_for_internal_slam` in
this same function, for the same reason: it's the one condition under
which "zero keys sent this call" provably holds. The
error-during-key-press-attempt case stays `false`, unreviewed, same
deliberate scope boundary already established for the internal slam's
own escalation.

### Site B: `cursor_anchor.rs`'s shared `resolve_caller_asserted_origin` (only reached under `AnchorGuard::CallerAsserted`)

This function is called from every `anchor_cursor` invocation using
`CallerAsserted`, regardless of caller — and the callers do NOT share
the same pre-history:

- **`unlock_ipad`'s own internal slam** (via `anchor_cursor`, the
  already-approved `bd4c448` extension): reached under the identical
  `try_key_press_first == Some(false)` precondition as Site A (same
  function, same call). **Same recommendation: gate on that condition,
  reusing the existing `allow_keyboard_wake_for_internal_slam` value.**
- **`ipad_go_home`** (`home.rs`): **ALWAYS sends `Cmd+H`
  unconditionally** (`client.send_shortcut(&["MetaLeft", "KeyH"])`)
  before ever reaching `anchor_cursor`/`CallerAsserted` (only reached
  at all when `force_home_via_swipe: true`). A real key has already
  gone out every single time this path is reached — the "zero keys
  sent" argument does NOT hold here. **Recommend: leave `false`,
  unreviewed** — same as `unlock_ipad`'s own default-config path.
- **`cursor_anchor_corner_control_smoke.rs`** (already reviewed and
  approved for its own before/after slam screenshots,
  `docs/corner-control-allow-keyboard-wake-decision.md`): the operator
  locks the device and confirms via screenshot BEFORE the run; nothing
  in the process sends a key between that confirmation and
  `anchor_cursor`'s own internal bounds detection (which runs before
  the slam's own screenshots, at the very start of `anchor_cursor`).
  **Same causal argument transfers cleanly — recommend `true`.**
- **`cursor_anchor_smoke.rs`** (a separate, simpler live gate, not yet
  extended for its own before/after screenshots either): same
  operator-confirmed-lock precondition, same argument would transfer,
  but out of scope for this proposal — it's not blocking anything today
  and can be extended later on its own if/when someone revisits that
  harness specifically.

## Implementation (if approved)

1. Add `pub allow_keyboard_wake: bool` to `DetectOptions` (already
   `#[derive(Default)]`, so this is a pure additive field, default
   `false` everywhere unless explicitly set).
2. `detect_ipad_bounds` changes its screenshot call from
   `client.screenshot(None)` to
   `client.screenshot(Some(ScreenshotOptions { allow_keyboard_wake: options.allow_keyboard_wake, ..Default::default() })).await?`.
3. `unlock.rs`'s own `detect_bounds_or_null(...)` call (Site A) computes
   the same `allow_keyboard_wake_for_internal_slam` boolean it already
   computes for the internal slam (or hoists that computation earlier
   in the function so both sites share it) and passes it into
   `DetectOptions`.
4. `cursor_anchor.rs`'s `resolve_caller_asserted_origin` (Site B) needs
   to know this same fact from ITS caller — `AnchorRequest` gains a new
   field, e.g. `pub allow_keyboard_wake_bounds_detection: bool` (no
   `Default` derive on `AnchorRequest`, so every real construction site
   needs an explicit value, same pattern as the two existing
   `allow_keyboard_wake_{before,after}` fields):
   - `unlock_ipad`'s internal-slam `AnchorRequest`: same value as
     `allow_keyboard_wake_for_internal_slam`.
   - `ipad_go_home`'s `AnchorRequest`: `false`.
   - `cursor_anchor_corner_control_smoke.rs`'s two `AnchorRequest`
     literals: `true`.
   - Every other existing call site (`measure.rs`'s `NoneCalibration`,
     `origin.rs`'s `BoundsGuard`, `cursor_anchor_smoke.rs`,
     `cursor_anchor/tests.rs`'s `default_req()`): `false` — either the
     guard type never reaches `resolve_caller_asserted_origin` at all
     (measure.rs, origin.rs — this field would simply be unused on
     those paths, but still needs a value to satisfy the struct
     literal), or it's out of scope per above (`cursor_anchor_smoke.rs`).

## Safety argument (same shape as the two already-approved sites)

Nothing new: this is the identical causal question already asked and
answered twice — does anything send a key/click between the point
where safety was established (an already-confirmed lock screen) and
this specific screenshot? Where the answer is provably no (Site A under
`try_key_press_first == Some(false)`, Site B for `unlock_ipad`'s
internal slam and for corner-control-smoke), the keypress escalation is
no more dangerous than the mouse-move it replaces. Where a key has
already gone out first (`ipad_go_home`, and `unlock_ipad`'s
default-config error path), this proposal deliberately does NOT extend
there — consistent with every prior decision in this chain.

## Open question for nixos-dev

Is hoisting the `try_key_press_first == Some(false)` boolean computation
to the top of `unlock_ipad` (so both Site A's `DetectOptions` and the
internal slam's `AnchorRequest` read the same computed value) the right
call, or should each site independently re-derive it from
`options.try_key_press_first`? Leaning toward hoisting (single source
of truth, avoids the two sites drifting if the condition is ever
revisited) but no strong objection to the alternative.
