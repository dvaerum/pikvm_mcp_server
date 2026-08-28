//! Median aggregation and the interpolating pixels-per-mickey lookup.
//! Faithful port of `medianKey`/`computeMedians`/`lookupPxPerMickey`.

use std::collections::HashMap;

use pikvm_mcp_foundation::util::median;

use super::types::{BallisticsProfile, BallisticsSample, Pace};
use crate::slam::Axis;

fn axis_str(axis: Axis) -> &'static str {
    match axis {
        Axis::X => "x",
        Axis::Y => "y",
    }
}

fn pace_str(pace: Pace) -> &'static str {
    match pace {
        Pace::Fast => "fast",
        Pace::Slow => "slow",
    }
}

/// `${axis}:${pace}:${magnitude}`. Rust's `{}` `f64` `Display` matches
/// JS's `Number.prototype.toString()` for the whole-number magnitudes
/// this module actually samples ([5,10,20,40,80,127] by default) — this
/// key is stored in a profile JSON that may be read/written by either
/// implementation during the port's parallel-build period, so the string
/// itself (not just the parsed value) must match byte-for-byte.
pub(super) fn median_key(axis: Axis, pace: Pace, magnitude: f64) -> String {
    format!("{}:{}:{}", axis_str(axis), pace_str(pace), magnitude)
}

pub(super) fn compute_medians(samples: &[BallisticsSample]) -> HashMap<String, f64> {
    let mut buckets: HashMap<String, Vec<f64>> = HashMap::new();
    for s in samples {
        buckets
            .entry(median_key(s.axis, s.pace, s.magnitude))
            .or_default()
            .push(s.px_per_mickey);
    }
    buckets
        .into_iter()
        .map(|(key, values)| (key, median(&values)))
        .collect()
}

/// Pixels per mickey for a given (axis, magnitude, pace). Interpolates
/// along the magnitude dimension when the exact magnitude wasn't sampled.
pub fn lookup_px_per_mickey(
    profile: &BallisticsProfile,
    axis: Axis,
    magnitude: f64,
    pace: Pace,
) -> Option<f64> {
    // Exact hit.
    if let Some(&exact) = profile.medians.get(&median_key(axis, pace, magnitude)) {
        return Some(exact);
    }

    // Interpolate across sampled magnitudes for this axis+pace.
    let mut sampled: Vec<(f64, f64)> = Vec::new();
    let axis_prefix = axis_str(axis);
    let pace_prefix = pace_str(pace);
    for (key, &value) in &profile.medians {
        let mut parts = key.split(':');
        let (Some(a), Some(p), Some(m)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if a == axis_prefix && p == pace_prefix {
            if let Ok(mag) = m.parse::<f64>() {
                sampled.push((mag, value));
            }
        }
    }
    if sampled.is_empty() {
        return None;
    }
    sampled.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    if magnitude <= sampled[0].0 {
        return Some(sampled[0].1);
    }
    let last = sampled[sampled.len() - 1];
    if magnitude >= last.0 {
        return Some(last.1);
    }

    for pair in sampled.windows(2) {
        let (lo_mag, lo_val) = pair[0];
        let (hi_mag, hi_val) = pair[1];
        if magnitude >= lo_mag && magnitude <= hi_mag {
            let t = (magnitude - lo_mag) / (hi_mag - lo_mag);
            return Some(lo_val + t * (hi_val - lo_val));
        }
    }
    None
}

/// Faithful port of `src/pikvm/__tests__/ballistics.test.ts`'s
/// `describe('lookupPxPerMickey', ...)` block. The TS fixtures also set
/// `measuredAt`/`notes` fields via `as unknown as BallisticsProfile`
/// casts that bypass TypeScript's structural check — neither field
/// exists on the real `BallisticsProfile` interface (which has
/// `createdAt`, no `notes`) and neither is read by `lookupPxPerMickey`
/// (only `.medians` is), so they're vestigial test-fixture drift, not a
/// real contract; these fixtures use the real `created_at` field instead.
#[cfg(test)]
mod tests {
    use super::*;
    use pikvm_mcp_kvmd_client::client::ScreenResolution;

    fn profile(medians: &[(&str, f64)]) -> BallisticsProfile {
        BallisticsProfile {
            version: 1,
            created_at: "2026-08-28T00:00:00.000Z".to_string(),
            resolution: ScreenResolution {
                width: 1920,
                height: 1080,
            },
            samples: Vec::new(),
            medians: medians.iter().map(|&(k, v)| (k.to_string(), v)).collect(),
        }
    }

    #[test]
    fn returns_null_when_profile_has_no_samples_for_the_requested_axis_pace_combo() {
        // Profile has only x:slow data — asking for y:fast must fall through.
        let p = profile(&[("x:slow:127", 1.2)]);
        assert_eq!(lookup_px_per_mickey(&p, Axis::Y, 60.0, Pace::Fast), None);
    }

    #[test]
    fn returns_the_only_available_data_point_when_one_magnitude_is_sampled() {
        // Legacy bug: profile has only magnitude=127 data, lookup is asked
        // for magnitude=60, returns the 127 value because there's nothing
        // to interpolate between. Pin this so we know the failure mode —
        // move-to.ts's profileIsFreshFor check (see persist.rs) is what
        // actually protects against this, not this function.
        let p = profile(&[("x:slow:127", 3.04)]);
        assert!(lookup_px_per_mickey(&p, Axis::X, 60.0, Pace::Slow).is_some());
    }

    fn multi_magnitude() -> BallisticsProfile {
        profile(&[
            ("x:slow:5", 12.4),
            ("x:slow:10", 6.0),
            ("x:slow:20", 3.0),
            ("x:slow:40", 1.5),
            ("x:slow:80", 0.75),
            ("x:slow:127", 0.49),
            ("y:slow:40", 3.7),
            ("y:slow:80", 1.8),
            ("y:slow:127", 1.0),
        ])
    }

    #[test]
    fn returns_the_exact_value_when_magnitude_matches_a_sampled_point() {
        let p = multi_magnitude();
        assert_eq!(
            lookup_px_per_mickey(&p, Axis::X, 20.0, Pace::Slow),
            Some(3.0)
        );
        assert_eq!(
            lookup_px_per_mickey(&p, Axis::X, 80.0, Pace::Slow),
            Some(0.75)
        );
        assert_eq!(
            lookup_px_per_mickey(&p, Axis::Y, 40.0, Pace::Slow),
            Some(3.7)
        );
    }

    #[test]
    fn clamps_to_the_smallest_sampled_magnitude_when_asked_below_the_range() {
        let p = multi_magnitude();
        // Smallest x:slow sample is at mag 5 → 12.4. Asked for mag 1.
        assert_eq!(
            lookup_px_per_mickey(&p, Axis::X, 1.0, Pace::Slow),
            Some(12.4)
        );
        // Smallest y:slow sample is at mag 40 → 3.7. Asked for mag 10.
        assert_eq!(
            lookup_px_per_mickey(&p, Axis::Y, 10.0, Pace::Slow),
            Some(3.7)
        );
    }

    #[test]
    fn clamps_to_the_largest_sampled_magnitude_when_asked_above_the_range() {
        let p = multi_magnitude();
        // Largest x:slow sample is at mag 127 → 0.49. Asked for mag 200.
        assert_eq!(
            lookup_px_per_mickey(&p, Axis::X, 200.0, Pace::Slow),
            Some(0.49)
        );
        assert_eq!(
            lookup_px_per_mickey(&p, Axis::Y, 250.0, Pace::Slow),
            Some(1.0)
        );
    }

    #[test]
    fn linearly_interpolates_between_two_adjacent_sampled_magnitudes() {
        let p = multi_magnitude();
        // Mag 30 sits halfway between 20 (ratio 3.0) and 40 (ratio 1.5).
        // Interpolated: 3.0 + 0.5 * (1.5 - 3.0) = 2.25.
        let r = lookup_px_per_mickey(&p, Axis::X, 30.0, Pace::Slow).unwrap();
        assert!((r - 2.25).abs() < 1e-5);
    }

    #[test]
    fn does_not_mix_axes_y_request_returns_null_if_y_slow_is_empty() {
        let p = profile(&[("x:slow:20", 3.0), ("x:slow:40", 1.5)]);
        assert_eq!(lookup_px_per_mickey(&p, Axis::Y, 30.0, Pace::Slow), None);
    }

    #[test]
    fn does_not_mix_paces_slow_request_does_not_see_fast_samples() {
        let p = profile(&[("x:fast:20", 3.0), ("x:fast:40", 1.5)]);
        assert_eq!(lookup_px_per_mickey(&p, Axis::X, 30.0, Pace::Slow), None);
        // But the same magnitude on the matching pace returns interpolation.
        let r = lookup_px_per_mickey(&p, Axis::X, 30.0, Pace::Fast).unwrap();
        assert!((r - 2.25).abs() < 1e-5);
    }

    #[test]
    fn median_key_matches_js_number_to_string_for_whole_number_magnitudes() {
        // Pins the byte-for-byte cross-implementation JSON-key format —
        // see median_key's own doc.
        assert_eq!(median_key(Axis::X, Pace::Slow, 5.0), "x:slow:5");
        assert_eq!(median_key(Axis::Y, Pace::Fast, 127.0), "y:fast:127");
    }

    #[test]
    fn compute_medians_takes_the_median_of_each_axis_pace_magnitude_bucket() {
        let samples = vec![
            BallisticsSample {
                axis: Axis::X,
                magnitude: 5.0,
                pace: Pace::Slow,
                call_count: 5,
                mickeys_emitted: 25.0,
                pixels_measured: 30.0,
                px_per_mickey: 1.2,
                rep: 1,
            },
            BallisticsSample {
                axis: Axis::X,
                magnitude: 5.0,
                pace: Pace::Slow,
                call_count: 5,
                mickeys_emitted: 25.0,
                pixels_measured: 35.0,
                px_per_mickey: 1.4,
                rep: 2,
            },
        ];
        let medians = compute_medians(&samples);
        let m = medians.get("x:slow:5").copied().unwrap();
        assert!((m - 1.3).abs() < 1e-9); // median of [1.2, 1.4]
    }
}
