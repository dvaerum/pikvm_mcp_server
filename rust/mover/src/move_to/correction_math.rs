//! Pure, already-well-tested math helpers extracted from `moveToPixel`'s
//! legacy correction loop. Faithful port of the corresponding functions
//! in `src/pikvm/move-to.ts` (lines 438-632).
//!
//! **Reconciled at merge time (2026-08-29, georgs-mac-mini)**: this file
//! shipped with its own provisional `MovePassDiagnostic`/`PassMode`
//! (documented then as "independently buildable/testable now, expected
//! to be superseded once both sides land") — swapped here for the real
//! `super::types::{MovePassDiagnostic, DetectionMode}` built in parallel
//! on the other branch. `should_abort_blind_corrections`/`pick_bail_pass`
//! only ever read `.mode`/`.residual_px`, so the swap is mechanical; no
//! logic changed.

use super::types::{DetectionMode, MovePassDiagnostic};

/// Anything with a 2D position and a match confidence score — the shape
/// `pick_nearest_plausible_match` is generic over. Mirrors the TS
/// source's own structural bound (`T extends { position: {x,y}; score:
/// number }`) as a small trait, since Rust has no structural typing.
pub trait ScoredPosition {
    fn position(&self) -> (f64, f64);
    fn score(&self) -> f64;
}

fn hypot(dx: f64, dy: f64) -> f64 {
    dx.hypot(dy)
}

/// Faithful port of `clamp` (move-to.ts line 438).
pub fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.min(hi).max(lo)
}

/// Phase 11: locality-aware ranking for multi-template match results.
/// When the cursor was just at `expected_near` (e.g. a confirmed prior
/// position from the previous correction pass), prefer candidates within
/// `radius_px` of that prior over far high-scoring matches. When
/// `expected_near` is `None`, OR when no candidates fall within the
/// radius, falls back to global highest-score selection. Faithful port
/// of `pickNearestPlausibleMatch`.
pub fn pick_nearest_plausible_match<T: ScoredPosition + Clone>(
    matches: &[T],
    expected_near: Option<(f64, f64)>,
    radius_px: f64,
) -> Option<T> {
    if matches.is_empty() {
        return None;
    }
    if let Some(near) = expected_near {
        let within: Vec<&T> = matches
            .iter()
            .filter(|m| {
                let (x, y) = m.position();
                hypot(x - near.0, y - near.1) <= radius_px
            })
            .collect();
        if !within.is_empty() {
            let best = within
                .into_iter()
                .reduce(|a, b| if a.score() > b.score() { a } else { b })
                .unwrap();
            return Some(best.clone());
        }
    }
    matches
        .iter()
        .cloned()
        .reduce(|a, b| if a.score() > b.score() { a } else { b })
}

/// Phase 9: cap a correction-pass emission so a single pass can't run
/// away on a stale ratio. Scales both axes proportionally so direction is
/// preserved when one axis exceeds the cap. Faithful port of
/// `capCorrectionMickeys`.
pub fn cap_correction_mickeys(mickeys_x: f64, mickeys_y: f64, cap: f64) -> (f64, f64) {
    let abs_x = mickeys_x.abs();
    let abs_y = mickeys_y.abs();
    let max = abs_x.max(abs_y);
    if max == 0.0 || max <= cap {
        return (mickeys_x, mickeys_y);
    }
    let scale = cap / max;
    ((mickeys_x * scale).round(), (mickeys_y * scale).round())
}

/// Phase 6: clamp the open-loop emit so the projected cursor landing
/// stays inside the screen bounds (with a small margin). Inputs with
/// ratio ≤ 0 are returned unchanged (no projection possible). Faithful
/// port of `clampMickeysToScreen` (margin defaults to 20, matching the
/// TS default parameter).
pub fn clamp_mickeys_to_screen(
    origin: (f64, f64),
    signed_mickeys_x: f64,
    signed_mickeys_y: f64,
    ratio_x: f64,
    ratio_y: f64,
    bounds: (f64, f64),
    margin: f64,
) -> (f64, f64) {
    let mut x = signed_mickeys_x;
    let mut y = signed_mickeys_y;
    let (bounds_w, bounds_h) = bounds;
    if ratio_x > 0.0 {
        let projected_x = origin.0 + x * ratio_x;
        if projected_x < margin {
            x = ((margin - origin.0) / ratio_x).ceil();
        } else if projected_x > bounds_w - margin {
            x = ((bounds_w - margin - origin.0) / ratio_x).floor();
        }
    }
    if ratio_y > 0.0 {
        let projected_y = origin.1 + y * ratio_y;
        if projected_y < margin {
            y = ((margin - origin.1) / ratio_y).ceil();
        } else if projected_y > bounds_h - margin {
            y = ((bounds_h - margin - origin.1) / ratio_y).floor();
        }
    }
    (x, y)
}

/// Default margin for [`clamp_mickeys_to_screen`], matching the TS
/// default parameter (`margin = 20`).
pub const DEFAULT_CLAMP_MARGIN: f64 = 20.0;

/// Phase 4: blind-pass circuit breaker. Returns true if the last 2
/// diagnostic entries are both `Predicted` mode — i.e., motion-diff and
/// template-match have BOTH failed twice in a row. Faithful port of
/// `shouldAbortBlindCorrections`.
pub fn should_abort_blind_corrections(diagnostics: &[MovePassDiagnostic]) -> bool {
    if diagnostics.len() < 2 {
        return false;
    }
    let last = &diagnostics[diagnostics.len() - 1];
    let second_last = &diagnostics[diagnostics.len() - 2];
    last.mode == DetectionMode::Predicted && second_last.mode == DetectionMode::Predicted
}

/// Phase 285 (v0.5.226): bail-with-best-pass-landing. Given a
/// `diagnostics` slice and the current `final_residual_px`, return the
/// index of the verified earlier pass that should replace the final
/// position, or -1 if no bail should occur. Verified passes = mode !=
/// `Predicted`. **Bails only when `final_residual_px` is infinite** — a
/// finite residual, even a large one, means the freshest signal said
/// something specific; trust it. Faithful port of `pickBailPass`.
pub fn pick_bail_pass(diagnostics: &[MovePassDiagnostic], final_residual_px: f64) -> i64 {
    if final_residual_px != f64::INFINITY {
        return -1;
    }
    let mut best_idx: i64 = -1;
    let mut best_residual = f64::INFINITY;
    for (i, d) in diagnostics.iter().enumerate() {
        if d.mode == DetectionMode::Predicted {
            continue;
        }
        if d.residual_px < best_residual {
            best_residual = d.residual_px;
            best_idx = i as i64;
        }
    }
    best_idx
}

/// Returns true if `current` should be rejected as a stale repeat of
/// `previous` after a correction whose magnitude is `emitted_mickeys`.
/// Faithful port of `isStaleTemplateMatch` — a 5 px drift threshold (real
/// cursor + JPEG noise rarely produces less than this when actually
/// re-detected) combined with a 30-mickey emission threshold (smaller
/// corrections may legitimately not move the cursor enough to register a
/// different match).
pub fn is_stale_template_match(
    current: (f64, f64),
    previous: Option<(f64, f64)>,
    emitted_mickeys: f64,
) -> bool {
    let Some(previous) = previous else {
        return false;
    };
    let drift = hypot(current.0 - previous.0, current.1 - previous.1);
    drift < 5.0 && emitted_mickeys >= 30.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::move_to::types::Point;

    fn diag(pass: u32, mode: DetectionMode) -> MovePassDiagnostic {
        MovePassDiagnostic {
            pass,
            mode,
            detected_at: Point { x: 0.0, y: 0.0 },
            residual_px: 100.0,
            ratio_used: (1.0, 1.0),
            reason: None,
            linear_phase: false,
        }
    }

    fn diag_at(
        pass: u32,
        mode: DetectionMode,
        residual_px: f64,
        detected_at: (f64, f64),
    ) -> MovePassDiagnostic {
        MovePassDiagnostic {
            residual_px,
            detected_at: Point {
                x: detected_at.0,
                y: detected_at.1,
            },
            ..diag(pass, mode)
        }
    }

    // -- pick_nearest_plausible_match --

    #[derive(Clone)]
    struct M {
        position: (f64, f64),
        score: f64,
    }
    impl ScoredPosition for M {
        fn position(&self) -> (f64, f64) {
            self.position
        }
        fn score(&self) -> f64 {
            self.score
        }
    }
    fn make(x: f64, y: f64, s: f64) -> M {
        M {
            position: (x, y),
            score: s,
        }
    }

    #[test]
    fn prefers_a_closer_to_hint_match_over_a_far_higher_scoring_one() {
        let matches = [make(800.0, 700.0, 0.94), make(1057.0, 837.0, 0.91)];
        let r = pick_nearest_plausible_match(&matches, Some((1027.0, 825.0)), 100.0).unwrap();
        assert_eq!(r.position, (1057.0, 837.0));
    }

    #[test]
    fn falls_back_to_highest_score_when_nothing_is_within_hint_radius() {
        let matches = [make(800.0, 700.0, 0.94), make(50.0, 50.0, 0.91)];
        let r = pick_nearest_plausible_match(&matches, Some((1027.0, 825.0)), 100.0).unwrap();
        assert_eq!(r.position, (800.0, 700.0));
        assert_eq!(r.score, 0.94);
    }

    #[test]
    fn returns_none_when_input_is_empty() {
        let matches: [M; 0] = [];
        assert!(pick_nearest_plausible_match(&matches, Some((100.0, 100.0)), 50.0).is_none());
    }

    #[test]
    fn returns_highest_score_when_no_hint_is_provided() {
        let matches = [
            make(0.0, 0.0, 0.5),
            make(100.0, 100.0, 0.95),
            make(200.0, 200.0, 0.7),
        ];
        let r = pick_nearest_plausible_match(&matches, None, 100.0).unwrap();
        assert_eq!(r.score, 0.95);
    }

    #[test]
    fn chooses_the_highest_score_match_within_radius_not_the_closest_one() {
        let matches = [make(20.0, 20.0, 0.85), make(50.0, 50.0, 0.93)];
        let r = pick_nearest_plausible_match(&matches, Some((0.0, 0.0)), 100.0).unwrap();
        assert_eq!(r.score, 0.93);
    }

    // -- cap_correction_mickeys --

    #[test]
    fn cap_correction_mickeys_returns_inputs_unchanged_when_both_axes_are_within_cap() {
        let (x, y) = cap_correction_mickeys(20.0, 30.0, 50.0);
        assert_eq!(x, 20.0);
        assert_eq!(y, 30.0);
    }

    #[test]
    fn cap_correction_mickeys_scales_both_axes_proportionally_when_x_exceeds_cap() {
        let (x, y) = cap_correction_mickeys(200.0, 50.0, 100.0);
        assert_eq!(x, 100.0);
        assert_eq!(y, 25.0);
    }

    #[test]
    fn cap_correction_mickeys_scales_both_axes_proportionally_when_y_exceeds_cap() {
        let (x, y) = cap_correction_mickeys(20.0, 200.0, 80.0);
        assert_eq!(x, 8.0);
        assert_eq!(y, 80.0);
    }

    #[test]
    fn cap_correction_mickeys_preserves_sign_when_scaling() {
        let (x, y) = cap_correction_mickeys(-200.0, 50.0, 100.0);
        assert_eq!(x, -100.0);
        assert_eq!(y, 25.0);
    }

    #[test]
    fn cap_correction_mickeys_passes_zero_through() {
        let (x, y) = cap_correction_mickeys(0.0, 0.0, 100.0);
        assert_eq!(x, 0.0);
        assert_eq!(y, 0.0);
    }

    // -- clamp_mickeys_to_screen --

    const BOUNDS: (f64, f64) = (1920.0, 1080.0);

    #[test]
    fn clamp_mickeys_to_screen_passes_through_when_projected_landing_is_well_within_screen() {
        let (x, y) = clamp_mickeys_to_screen(
            (500.0, 500.0),
            100.0,
            50.0,
            1.0,
            1.0,
            BOUNDS,
            DEFAULT_CLAMP_MARGIN,
        );
        assert_eq!(x, 100.0);
        assert_eq!(y, 50.0);
    }

    #[test]
    fn clamp_mickeys_to_screen_caps_positive_x_mickeys_to_keep_cursor_inside_the_right_edge() {
        let (x, y) = clamp_mickeys_to_screen(
            (1900.0, 500.0),
            200.0,
            0.0,
            1.0,
            1.0,
            BOUNDS,
            DEFAULT_CLAMP_MARGIN,
        );
        assert!(x <= 0.0);
        assert_eq!(y, 0.0);
    }

    #[test]
    fn clamp_mickeys_to_screen_caps_negative_y_mickeys_to_keep_cursor_inside_the_top_edge() {
        let (x, y) = clamp_mickeys_to_screen(
            (500.0, 30.0),
            0.0,
            -200.0,
            1.0,
            1.0,
            BOUNDS,
            DEFAULT_CLAMP_MARGIN,
        );
        assert!(y >= -15.0);
        assert_eq!(x, 0.0);
    }

    #[test]
    fn clamp_mickeys_to_screen_preserves_direction_when_clamping() {
        let (x, y) = clamp_mickeys_to_screen(
            (1900.0, 500.0),
            500.0,
            100.0,
            2.0,
            1.0,
            BOUNDS,
            DEFAULT_CLAMP_MARGIN,
        );
        assert!(x >= 0.0);
        assert_eq!(y, 100.0);
    }

    #[test]
    fn clamp_mickeys_to_screen_handles_ratio_zero_gracefully() {
        let (x, y) = clamp_mickeys_to_screen(
            (500.0, 500.0),
            100.0,
            50.0,
            0.0,
            0.0,
            BOUNDS,
            DEFAULT_CLAMP_MARGIN,
        );
        assert_eq!(x, 100.0);
        assert_eq!(y, 50.0);
    }

    // -- should_abort_blind_corrections --

    #[test]
    fn should_abort_blind_corrections_false_on_the_first_predicted_pass() {
        let ds = [
            diag(0, DetectionMode::Motion),
            diag(1, DetectionMode::Predicted),
        ];
        assert!(!should_abort_blind_corrections(&ds));
    }

    #[test]
    fn should_abort_blind_corrections_true_after_2_consecutive_predicted_passes() {
        let ds = [
            diag(0, DetectionMode::Motion),
            diag(1, DetectionMode::Predicted),
            diag(2, DetectionMode::Predicted),
        ];
        assert!(should_abort_blind_corrections(&ds));
    }

    #[test]
    fn should_abort_blind_corrections_a_template_recovered_pass_resets_the_streak() {
        let ds = [
            diag(0, DetectionMode::Motion),
            diag(1, DetectionMode::Predicted),
            diag(2, DetectionMode::Template),
            diag(3, DetectionMode::Predicted),
        ];
        assert!(!should_abort_blind_corrections(&ds));
    }

    #[test]
    fn should_abort_blind_corrections_false_on_an_empty_diagnostic_list() {
        assert!(!should_abort_blind_corrections(&[]));
    }

    #[test]
    fn should_abort_blind_corrections_false_if_last_pass_is_verified() {
        let ds = [
            diag(0, DetectionMode::Predicted),
            diag(1, DetectionMode::Predicted),
            diag(2, DetectionMode::Motion),
        ];
        assert!(!should_abort_blind_corrections(&ds));
    }

    // -- pick_bail_pass --

    #[test]
    fn pick_bail_pass_returns_minus_one_when_no_diagnostics_and_no_final_detection() {
        assert_eq!(pick_bail_pass(&[], f64::INFINITY), -1);
    }

    #[test]
    fn pick_bail_pass_returns_minus_one_when_final_detection_exists() {
        let ds = [
            diag_at(0, DetectionMode::Motion, 30.0, (750.0, 800.0)),
            diag_at(1, DetectionMode::Motion, 25.0, (755.0, 805.0)),
        ];
        assert_eq!(pick_bail_pass(&ds, 500.0), -1);
        assert_eq!(pick_bail_pass(&ds, 50.0), -1);
        assert_eq!(pick_bail_pass(&ds, 0.0), -1);
    }

    #[test]
    fn pick_bail_pass_returns_minus_one_when_final_null_but_only_predicted_passes_exist() {
        let ds = [
            diag(0, DetectionMode::Predicted),
            diag(1, DetectionMode::Predicted),
        ];
        assert_eq!(pick_bail_pass(&ds, f64::INFINITY), -1);
    }

    #[test]
    fn pick_bail_pass_bails_to_verified_pass_when_final_is_null() {
        let ds = [
            diag_at(0, DetectionMode::Motion, 100.0, (800.0, 800.0)),
            diag_at(1, DetectionMode::Motion, 50.0, (750.0, 800.0)),
            diag(2, DetectionMode::Predicted),
        ];
        assert_eq!(pick_bail_pass(&ds, f64::INFINITY), 1);
    }

    #[test]
    fn pick_bail_pass_picks_the_smallest_residual_verified_pass_when_multiple_exist() {
        let ds = [
            diag(0, DetectionMode::Motion),
            diag_at(1, DetectionMode::Template, 30.0, (755.0, 830.0)),
            diag_at(2, DetectionMode::Shape, 50.0, (0.0, 0.0)),
            diag(3, DetectionMode::Predicted),
        ];
        assert_eq!(pick_bail_pass(&ds, f64::INFINITY), 1);
    }

    #[test]
    fn pick_bail_pass_treats_motion_template_shape_modes_equivalently_as_verified() {
        let ds = [
            diag_at(0, DetectionMode::Motion, 50.0, (0.0, 0.0)),
            diag_at(1, DetectionMode::Template, 70.0, (0.0, 0.0)),
            diag_at(2, DetectionMode::Shape, 30.0, (0.0, 0.0)),
        ];
        assert_eq!(pick_bail_pass(&ds, f64::INFINITY), 2);
    }

    #[test]
    fn pick_bail_pass_ignores_predicted_mode_passes_even_when_residual_is_small() {
        let ds = [
            diag_at(0, DetectionMode::Predicted, 5.0, (0.0, 0.0)),
            diag_at(1, DetectionMode::Motion, 30.0, (0.0, 0.0)),
        ];
        assert_eq!(pick_bail_pass(&ds, f64::INFINITY), 1);
    }

    #[test]
    fn pick_bail_pass_returns_the_first_occurrence_on_ties() {
        let ds = [
            diag_at(0, DetectionMode::Motion, 30.0, (1.0, 1.0)),
            diag_at(1, DetectionMode::Motion, 30.0, (2.0, 2.0)),
        ];
        assert_eq!(pick_bail_pass(&ds, f64::INFINITY), 0);
    }

    // -- is_stale_template_match --

    #[test]
    fn is_stale_template_match_accepts_first_template_match() {
        assert!(!is_stale_template_match((100.0, 100.0), None, 100.0));
    }

    #[test]
    fn is_stale_template_match_accepts_when_position_differs_significantly() {
        assert!(!is_stale_template_match(
            (200.0, 100.0),
            Some((100.0, 100.0)),
            100.0
        ));
    }

    #[test]
    fn is_stale_template_match_rejects_same_position_after_significant_emission() {
        assert!(is_stale_template_match(
            (100.0, 100.0),
            Some((100.0, 100.0)),
            100.0
        ));
    }

    #[test]
    fn is_stale_template_match_accepts_same_position_match_when_emission_was_small() {
        assert!(!is_stale_template_match(
            (100.0, 100.0),
            Some((100.0, 100.0)),
            5.0
        ));
    }

    #[test]
    fn is_stale_template_match_rejects_matches_within_5px_of_last_after_large_emission() {
        assert!(is_stale_template_match(
            (102.0, 99.0),
            Some((100.0, 100.0)),
            200.0
        ));
    }

    #[test]
    fn is_stale_template_match_accepts_more_than_5px_drift_after_large_emission() {
        assert!(!is_stale_template_match(
            (110.0, 100.0),
            Some((100.0, 100.0)),
            200.0
        ));
    }

    #[test]
    fn is_stale_template_match_regression_ipad_modal_false_positive_scenario() {
        let last = (1151.0, 696.0);
        let now = (1151.0, 696.0);
        let emitted_mag = (192f64 * 192.0 + 121.0 * 121.0).sqrt();
        assert!(emitted_mag > 30.0);
        assert!(is_stale_template_match(now, Some(last), emitted_mag));
    }
}
