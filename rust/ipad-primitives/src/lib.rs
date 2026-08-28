//! Shared iPad-adjacent primitives that both module 4 (mover/HID
//! orchestration) and module 5 (iPad-specific/HID recovery) depend on,
//! rather than depending on each other.
//!
//! See `docs/rust-port-plan.md` §7 and `docs/adr/0002-rust-port-full-bigbang.md`.
//!
//! `click_verify`: a SUBSET of `src/pikvm/click-verify.ts` — the two pure
//! default-lookup functions (only need `foundation`), plus
//! `run_dismiss_recipe`/`format_dismiss_result` (pulled in 2026-08-28 for
//! Module 6's `pikvm_dismiss_popup` tool). The rest of that TS file
//! (`verifyClickByDecodedFrames`/`verifyClickByDiff`/`chunkMickeys`/
//! `biasCorrectedAimPoint`/etc.) belongs to move-to.ts's/click-at.ts's own
//! future port — parked, not ported here. `take_raw_screenshot`
//! (`src/pikvm/ballistics.ts`) is deferred until ballistics.ts itself is
//! ported — it takes the concrete client type directly, not an injected
//! closure, per the TS source (checked, not assumed).
//!
//! `ipad_keys` (`src/pikvm/ipad-keys.ts`): moved here from module 5's crate
//! (2026-08-28) once cursor-anchor.ts's real callers were traced —
//! ipad-unlock.ts and cursor-anchor.ts both need it, so it lives in the
//! crate neither of them has to depend on the other to reach.
//!
//! `emit_chunked` (`src/pikvm/gesture.ts`) is NOT here, despite this
//! crate's original plan (2026-08-28) to host it: that plan assumed
//! ipad-unlock.ts belonged to module 5 (ipad-hid), the same premise that
//! motivated `ipad_keys`'s move here. Tracing the REAL import graph found
//! ipad-unlock.ts's only actual imports are client.ts, cursor-anchor.ts,
//! orientation.ts, ipad-keys.ts, and util.ts — nothing ipad-hid-exclusive
//! — so it belongs in `rust/mover` alongside cursor-anchor.ts (same
//! crate-placement reasoning, documented in docs/rust-port-plan.md).
//! `emit_chunked`'s only two real callers (move-to.ts, ipad-unlock.ts) are
//! BOTH destined for `rust/mover`, so it lives there directly
//! (`mover::gesture`) rather than through this crate — nothing outside
//! mover needs it.

pub mod click_verify;
pub mod ipad_keys;
