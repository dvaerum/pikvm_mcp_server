//! The single-report displacement curve, its inversion, and the burst
//! planner built on top of it. Faithful port of `curve-mover.ts`'s
//! `EMIT_CURVE_X`/`FULL_REPORT_PX`/`Y_SCALE`/`mickeysForReport`/
//! `planAxisEmits`, plus the correction-gate derivation
//! (`deriveCorrectionGatePx` and its constants) — pure math with no
//! client dependency, cohesive with the curve it derives a tolerance
//! band against.

/// Single-report displacement curve: `[mickeys, |HDMI px|]` on the X
/// axis. Measured via `getCursor` ground truth (fine-emit-probe +
/// wide-emit-probe).
pub const EMIT_CURVE_X: &[(f64, f64)] = &[
    (0.0, 0.0),
    (5.0, 2.4),
    (8.0, 4.9),
    (12.0, 8.2),
    (16.0, 11.5),
    (20.0, 15.0),
    (40.0, 49.0),
    (60.0, 89.0),
    (80.0, 120.0),
    (100.0, 136.0),
    (127.0, 157.0),
];
/// One full ±127 report's displacement (px). Bursts add this linearly.
pub const FULL_REPORT_PX: f64 = 157.0;
/// Y displacement = X × this (isotropic in logical space; the factor is
/// the HDMI aspect-mapping ratio, ~0.965 for this setup).
pub const Y_SCALE: f64 = 0.965;

/// DEFAULT per-report Y-axis drift compensation (applied as
/// `curve_scale_y` unless a caller overrides it). POINT-IN-TIME value —
/// NOT a permanent constant.
///
/// WHY: the curve one-shot systematically overshot on Y by ~+3.64% on
/// long moves (measured 2026-07-31, georgs, held-out N=80/arm), landing
/// ~25px at some geometries — over the `maxResidualPx=25` gate.
/// Compensating with this scale brought the held-out set from median
/// 27.0px / 63% would-skip → 4.5px / 1%.
///
/// PROVENANCE = DRIFT, not a fixed miscalibration: `Y_SCALE` is
/// structurally `(region_h/region_w) × (logicalW/logicalH)`, and the
/// DETECTED iPad HDMI region moved from the documented {692×956} to the
/// current {680×968} (aspect +3.04%). `Y_SCALE=0.965` was ~exact for the
/// documented region (back-solves to 0.9600) but is 2.5% low for the
/// current one. So this constant is correct for TODAY's region and WILL
/// go stale on the next HDMI/resolution/scaling change.
///
/// VALUE = 1.0364, the BEHAVIORALLY-validated compensation
/// (landing-error calibrated). Do NOT "simplify" it to the geometric
/// ratio: the getCursor/V8-measured true Y:X ratio today is 0.9892 (a
/// 2.51% geometric error → ~1.0109 compensation), but behavior needs
/// 3.64% — per-report Y is 151.50px modelled vs 155.55px measured. The
/// extra ~1pp is the `mickeys_for_report` partial-report
/// curve-interpolation term that a pure geometric ratio misses; a
/// ratio-derived scale would silently leave ~a third of the error in.
///
/// HOW TO RECOMPUTE on the next drift: re-run the equal-mickey X-vs-Y
/// landing measurement against `getCursor` (or the V8 detector,
/// corner-free, ~30s on the rig) and refit against MEASURED landing
/// error, not the geometric region ratio. Proper self-healing (learn it
/// into `ballistics.json`) is a deferred follow-up.
pub const DEFAULT_CURVE_SCALE_Y: f64 = 1.0364;

/// Invert the single-report curve: mickeys needed for a desired |px|
/// (0..full).
pub fn mickeys_for_report(px: f64) -> f64 {
    mickeys_for_report_curve(px, EMIT_CURVE_X, FULL_REPORT_PX)
}

/// `mickeys_for_report`, generalized over a caller-supplied curve/full —
/// `emit_toward`'s Y-axis call uses `CURVE_Y`/`FULL_REPORT_PX * Y_SCALE`.
pub(super) fn mickeys_for_report_curve(px: f64, curve: &[(f64, f64)], full: f64) -> f64 {
    let a = px.abs().min(full).max(0.0);
    for i in 1..curve.len() {
        let (m0, p0) = curve[i - 1];
        let (m1, p1) = curve[i];
        if a <= p1 {
            return (m0 + (m1 - m0) * (a - p0) / (p1 - p0)).round();
        }
    }
    127.0
}

/// Plan a signed sequence of per-report deltas (one axis) to move `d`
/// px: full ±127 reports for the bulk + one partial report for the
/// remainder. `scale` accounts for the current geometry: actual
/// displacement = `scale` × reference-curve displacement, so we plan
/// against the reference curve using the scaled-down distance
/// `d/scale`. `scale=1` is the reference session.
pub fn plan_axis_emits(d: f64, full: f64, curve: &[(f64, f64)], scale: f64) -> Vec<f64> {
    let sign = d.signum();
    let dist = d.abs() / scale;
    let n_full = (dist / full).floor() as u32;
    let rem = dist - n_full as f64 * full;
    let mut out = Vec::with_capacity(n_full as usize + 1);
    for _ in 0..n_full {
        out.push(sign * 127.0);
    }
    if rem >= 2.0 {
        out.push(sign * mickeys_for_report_curve(rem, curve, full));
    }
    out
}

// ── Correction-gate invariant (2026-07-31) ─────────────────────────────
//
// The curve one-shot has a systematic, near-deterministic open-loop
// error per geometry (measured spread 17.3-19.2px on a long move;
// ~25.3px at one gate geometry). The mover already has a correction shot
// to mop that up, but its gate (`correct_gate_px`) was an independent
// default of 30, which sat ABOVE the caller's acceptance gate
// (`maxResidualPx=25`) — so a residual in the [25,30) DEAD BAND was
// rejected by the clicker yet never re-shot by the mover (measured:
// 18.2px identical for faded/visible — the wake is net-zero; the
// confound was move-distance, not woken-ness). Fix: DERIVE the
// correction gate FROM the acceptance gate the caller threads in, so the
// two can't silently drift (that was the move-to.ts hole).
//
// FRACTION = 1.0 (georgs-measured 2026-07-31): `correct_gate_px ==
// accept_gate_px`, i.e. "correct IFF the shot would otherwise SKIP."
// Rationale: one correction cycle costs 1.37s (full detect+emit+settle)
// — material — so we do NOT spend it tightening shots that already pass;
// and this makes `accept_gate_px` the SINGLE, visible expression of
// how-close-is-close-enough.

/// The `correct_gate_px == accept_gate_px` invariant fraction.
pub const CORRECTION_GATE_FRACTION: f64 = 1.0;
/// The achievable-precision floor — corrected shots land ~8px, so an
/// acceptance gate below this can't be met; we make ONE correction and
/// then skip honestly (never a retry loop). The correction gate never
/// drops below it (nothing to gain).
pub const CORRECTION_GATE_FLOOR_PX: f64 = 8.0;
/// Canonical iPad acceptance gate — MUST mirror `click-verify.ts`'s
/// `maxResidualPx` default (`default_max_residual_px_for`); a test ties
/// the two so they can't drift. Used to derive a sane correction gate
/// when a caller doesn't thread its acceptance gate. Tightened 25→15 on
/// 2026-07-31 (task #38, PIN-key tolerance).
pub const DEFAULT_ACCEPT_GATE_PX: f64 = 15.0;

/// Derive the correction gate from the caller's acceptance gate: gate ==
/// accept (f=1.0 → correct iff the shot would otherwise skip), floored
/// at the ~8px achievable precision (a tighter acceptance than we can
/// hit gets one correction then an honest skip, not a loop). For any
/// acceptance gate ≥ the floor, gate ≤ accept — the dead band is closed
/// by construction.
pub fn derive_correction_gate_px(accept_gate_px: Option<f64>) -> f64 {
    let accept = match accept_gate_px {
        Some(v) if v > 0.0 => v,
        _ => DEFAULT_ACCEPT_GATE_PX,
    };
    (accept * CORRECTION_GATE_FRACTION)
        .round()
        .max(CORRECTION_GATE_FLOOR_PX)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Faithful port of `curve-mover.test.ts`'s `mickeysForReport`/
    /// `planAxisEmits` describe blocks.
    mod mickeys_for_report_tests {
        use super::*;

        #[test]
        fn maps_0_px_to_0_mickeys() {
            assert_eq!(mickeys_for_report(0.0), 0.0);
        }

        #[test]
        fn recovers_exact_curve_knots() {
            // 8 mickeys -> 4.9px, so 4.9px -> 8 mickeys
            assert_eq!(mickeys_for_report(4.9), 8.0);
            assert_eq!(mickeys_for_report(49.0), 40.0);
            assert_eq!(mickeys_for_report(157.0), 127.0);
        }

        #[test]
        fn interpolates_between_knots() {
            // between 4.9(8) and 8.2(12): 6.5px ~ 10 mickeys
            let m = mickeys_for_report(6.5);
            assert!(m > 8.0);
            assert!(m < 12.0);
        }

        #[test]
        fn clamps_above_the_full_report_displacement_to_127() {
            assert_eq!(mickeys_for_report(FULL_REPORT_PX + 50.0), 127.0);
        }

        #[test]
        fn is_sign_agnostic_takes_magnitude() {
            assert_eq!(mickeys_for_report(-49.0), 40.0);
        }
    }

    mod plan_axis_emits_tests {
        use super::*;

        fn plan(d: f64) -> Vec<f64> {
            plan_axis_emits(d, FULL_REPORT_PX, EMIT_CURVE_X, 1.0)
        }

        #[test]
        fn returns_a_single_partial_report_for_a_short_move() {
            assert_eq!(plan(4.9), vec![8.0]);
        }

        #[test]
        fn preserves_sign_negative_distance_negative_emits() {
            assert_eq!(plan(-4.9), vec![-8.0]);
        }

        #[test]
        fn drops_sub_2px_remainders_below_resolvable_step() {
            assert_eq!(plan(1.0), Vec::<f64>::new());
        }

        #[test]
        fn uses_full_127_reports_plus_a_partial_for_long_moves() {
            // 300px = 157 (one full report) + 143 remainder
            let p = plan(300.0);
            assert_eq!(p[0], 127.0);
            assert_eq!(p.len(), 2);
            assert!(p[1] > 0.0);
            assert!(p[1] <= 127.0);
        }

        #[test]
        fn long_negative_move_all_reports_negative() {
            let p = plan(-450.0);
            assert!(p.iter().all(|&e| e < 0.0));
            // 450 = 2×157 + 136
            assert_eq!(p.iter().filter(|&&e| e == -127.0).count(), 2);
        }

        #[test]
        fn scale_gt_1_bigger_geometry_needs_fewer_mickeys_for_the_same_px() {
            // reference: 49px -> 40 mickeys. If actual displacement is 1.5x
            // (scale=1.5), 49px needs only mickeys_for_report(49/1.5) < 40.
            let ref_plan = plan_axis_emits(49.0, FULL_REPORT_PX, EMIT_CURVE_X, 1.0);
            let scaled_plan = plan_axis_emits(49.0, FULL_REPORT_PX, EMIT_CURVE_X, 1.5);
            assert!(scaled_plan[0] < ref_plan[0]);
        }

        #[test]
        fn scale_splits_a_long_move_into_fewer_full_reports_each_moves_scale_times_full() {
            // 300px at scale=2: each full report moves 2×157=314>300 -> 0
            // full + partial
            let p = plan_axis_emits(300.0, FULL_REPORT_PX, EMIT_CURVE_X, 2.0);
            assert_eq!(p.iter().filter(|&&e| e.abs() == 127.0).count(), 0);
        }

        #[test]
        fn scale_1_is_unchanged_from_the_default() {
            assert_eq!(
                plan_axis_emits(300.0, FULL_REPORT_PX, EMIT_CURVE_X, 1.0),
                plan(300.0)
            );
        }

        #[test]
        fn curve_knots_are_monotonic_in_both_px_and_mickeys() {
            for i in 1..EMIT_CURVE_X.len() {
                assert!(EMIT_CURVE_X[i].0 > EMIT_CURVE_X[i - 1].0);
                assert!(EMIT_CURVE_X[i].1 > EMIT_CURVE_X[i - 1].1);
            }
        }
    }

    /// Faithful port of `curve-mover.correction-gate.test.ts`'s
    /// `deriveCorrectionGatePx` describe block (the gate-ordering
    /// invariant, f=1.0).
    mod derive_correction_gate_px_tests {
        use super::*;

        #[test]
        fn equals_the_acceptance_gate_for_the_production_default_correct_iff_would_skip() {
            assert_eq!(derive_correction_gate_px(Some(25.0)), 25.0);
        }

        #[test]
        fn invariant_derived_gate_never_exceeds_the_acceptance_gate_no_dead_band_for_any_sane_gate()
        {
            for accept in [
                8.0, 10.0, 12.0, 15.0, 20.0, 25.0, 30.0, 40.0, 50.0, 80.0, 100.0,
            ] {
                assert!(derive_correction_gate_px(Some(accept)) <= accept);
            }
        }

        #[test]
        fn floors_at_the_8px_achievable_precision_a_sub_floor_acceptance_gets_one_correction_then_honest_skip(
        ) {
            // 8, above the unmeetable 6
            assert_eq!(
                derive_correction_gate_px(Some(6.0)),
                CORRECTION_GATE_FLOOR_PX
            );
            assert_eq!(
                derive_correction_gate_px(Some(8.0)),
                CORRECTION_GATE_FLOOR_PX
            );
        }

        #[test]
        fn falls_back_to_the_canonical_acceptance_default_when_the_gate_is_absent_or_disabled() {
            assert_eq!(
                derive_correction_gate_px(None),
                derive_correction_gate_px(Some(DEFAULT_ACCEPT_GATE_PX))
            );
            assert_eq!(
                derive_correction_gate_px(Some(0.0)),
                derive_correction_gate_px(Some(DEFAULT_ACCEPT_GATE_PX))
            );
        }

        // georgs's regression: the two DEFAULTS must stay tied — this is
        // exactly how the mover's hardcoded 30 silently drifted above the
        // clicker's 25.
        #[test]
        fn the_fallback_acceptance_default_matches_click_verifys_real_max_residual_px_default_ipad()
        {
            // false = relative-mouse (iPad)
            let expected =
                pikvm_mcp_ipad_primitives::click_verify::default_max_residual_px_for(false);
            assert_eq!(Some(DEFAULT_ACCEPT_GATE_PX), expected);
        }

        #[test]
        fn the_derived_default_correction_gate_is_never_above_the_acceptance_default_the_dead_band_the_bug_had(
        ) {
            assert!(
                derive_correction_gate_px(Some(DEFAULT_ACCEPT_GATE_PX)) <= DEFAULT_ACCEPT_GATE_PX
            );
        }

        #[test]
        fn the_correction_gate_follows_the_acceptance_gate_task_38_15_gate_15_one_knob_via_f_1_0() {
            assert_eq!(DEFAULT_ACCEPT_GATE_PX, 15.0); // tightened from 25
            assert_eq!(derive_correction_gate_px(Some(15.0)), 15.0);
        }
    }
}
