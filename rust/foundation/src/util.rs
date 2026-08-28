//! Cross-module helpers used by the pikvm implementation modules.
//!
//! Faithful port of `src/pikvm/util.ts`.

use std::time::Duration;

/// Async sleep. Faithful port of `sleep(ms)`.
pub async fn sleep(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// Median of a numeric slice. Returns `NaN` for an empty slice — same
/// contract as the TypeScript `median()`, which the calibration
/// (auto-calibrate) and ballistics sampling pipelines rely on to aggregate
/// per-round ratios outlier-resistantly.
pub fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    let mut sorted: Vec<f64> = values.to_vec();
    // total_cmp (not partial_cmp) so a stray NaN in the input sorts to a
    // deterministic position instead of making sort_by's ordering
    // unspecified — the TS version's `.sort((a, b) => a - b)` would put NaN
    // comparisons at the mercy of V8's engine-specific quirks, so this is
    // arguably a hair more defined than the original, but produces the same
    // answer for any input this codebase actually feeds it (no NaNs).
    sorted.sort_by(|a, b| a.total_cmp(b));
    let mid = sorted.len() / 2;
    if !sorted.len().is_multiple_of(2) {
        sorted[mid]
    } else {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sleep_resolves_after_roughly_the_requested_duration() {
        let start = tokio::time::Instant::now();
        sleep(10).await;
        assert!(start.elapsed() >= Duration::from_millis(10));
    }

    #[test]
    fn median_of_empty_slice_is_nan() {
        assert!(median(&[]).is_nan());
    }

    #[test]
    fn median_of_odd_length_is_the_middle_element() {
        assert_eq!(median(&[3.0, 1.0, 2.0]), 2.0);
    }

    #[test]
    fn median_of_even_length_is_the_mean_of_the_two_middle_elements() {
        assert_eq!(median(&[1.0, 2.0, 3.0, 4.0]), 2.5);
    }

    #[test]
    fn median_of_single_element_is_that_element() {
        assert_eq!(median(&[42.0]), 42.0);
    }

    #[test]
    fn median_does_not_mutate_input_order_semantics_duplicates_preserved() {
        // Faithful-port regression: the TS version spreads into a copy before
        // sorting ([...values].sort(...)), so the caller's array is never
        // mutated. Rust's &[f64] can't be mutated through a shared reference
        // anyway, so this is structurally guaranteed here — this test exists
        // to document that guarantee explicitly, matching the TS doc intent.
        let input = [5.0, 5.0, 1.0, 5.0];
        assert_eq!(median(&input), 5.0);
        assert_eq!(input, [5.0, 5.0, 1.0, 5.0]); // unchanged
    }
}
