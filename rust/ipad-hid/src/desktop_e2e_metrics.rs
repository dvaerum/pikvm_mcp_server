//! Pure metric helpers for the desktop end-to-end harness
//! (`benches/desktop-e2e.ts`). Kept out of the bench so the target-grid,
//! residual, landed-cluster, and summary logic is unit-testable WITHOUT a
//! live PiKVM — the harness itself needs a real desktop behind the
//! appliance, but its math should not.
//!
//! Faithful port of `src/pikvm/desktop-e2e-metrics.ts`.
//!
//! The harness measures the ABSOLUTE-mouse path (`--target desktop`): after
//! `auto_calibrate`, it drives `mouseMove(x,y)` to each grid target and uses
//! a motion diff to find where the cursor actually landed. Residual = pixel
//! distance between the landed cursor and the requested target.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// A candidate cursor location from a motion diff (a cluster centroid).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClusterCentroid {
    pub centroid_x: f64,
    pub centroid_y: f64,
    pub pixels: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrialResult {
    pub target: Point,
    /// Where the cursor was found after the move, or `None` if the diff found nothing.
    pub landed: Option<Point>,
    /// Pixel distance landed↔target, or `None` when not located.
    pub residual_px: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Summary {
    pub n: usize,
    pub located: usize,
    /// Fraction of targets where the cursor was located after the move (0..1).
    pub locate_rate: f64,
    /// Median / 90th-percentile residual over LOCATED trials (px); `None` if none located.
    pub residual_p50: Option<f64>,
    pub residual_p90: Option<f64>,
    pub worst_residual_px: Option<f64>,
    pub threshold_px: f64,
    /// True iff every target located AND residualP90 <= thresholdPx.
    pub passed: bool,
}

/// A grid of absolute-pixel targets, inset from each edge by `margin_frac` of
/// the frame so targets never sit under a taskbar/menu bar or off-screen.
/// Row-major (top-left first). `cols`/`rows` >= 1.
pub fn build_target_grid(
    width: f64,
    height: f64,
    cols: u32,
    rows: u32,
    margin_frac: f64,
) -> anyhow::Result<Vec<Point>> {
    if cols < 1 || rows < 1 {
        anyhow::bail!("build_target_grid: cols and rows must be >= 1");
    }
    if !(0.0..0.5).contains(&margin_frac) {
        anyhow::bail!("build_target_grid: margin_frac must be in [0, 0.5)");
    }
    let x0 = width * margin_frac;
    let x1 = width * (1.0 - margin_frac);
    let y0 = height * margin_frac;
    let y1 = height * (1.0 - margin_frac);
    // Single row/col → place at the midpoint (avoid div-by-zero); else span edges.
    let lerp = |a: f64, b: f64, i: u32, n: u32| -> f64 {
        if n == 1 {
            (a + b) / 2.0
        } else {
            a + (b - a) * (i as f64) / ((n - 1) as f64)
        }
    };
    let mut out = Vec::with_capacity((cols * rows) as usize);
    for r in 0..rows {
        for c in 0..cols {
            out.push(Point {
                x: lerp(x0, x1, c, cols).round(),
                y: lerp(y0, y1, r, rows).round(),
            });
        }
    }
    Ok(out)
}

/// Euclidean pixel distance.
pub fn residual_px(a: Point, b: Point) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

pub struct LandedCluster {
    pub landed: Point,
    pub residual_px: f64,
}

/// From the motion-diff clusters, pick the cursor landing: the cluster
/// centroid NEAREST the requested target (a move that lands near target
/// produces a change cluster there; picking nearest-to-target rejects
/// unrelated screen churn). Returns the landed point + its residual, or
/// `None` when there are no clusters.
pub fn pick_landed_cluster(clusters: &[ClusterCentroid], target: Point) -> Option<LandedCluster> {
    let mut best: Option<LandedCluster> = None;
    for c in clusters {
        let landed = Point {
            x: c.centroid_x,
            y: c.centroid_y,
        };
        let d = residual_px(landed, target);
        if best.as_ref().is_none_or(|b| d < b.residual_px) {
            best = Some(LandedCluster {
                landed,
                residual_px: d,
            });
        }
    }
    best
}

/// Percentile (0..100) of a numeric list via nearest-rank; `[]` → `None`.
pub fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as i64;
    let idx = (sorted.len() as i64 - 1).min(rank - 1).max(0) as usize;
    Some(sorted[idx])
}

/// Roll trial results into a pass/fail summary. PASS requires every target
/// located AND the 90th-percentile residual within `threshold_px` — so a
/// single blind miss (unlocated) or a fat tail fails the run.
pub fn summarize_residuals(results: &[TrialResult], threshold_px: f64) -> Summary {
    let n = results.len();
    let residuals: Vec<f64> = results.iter().filter_map(|r| r.residual_px).collect();
    let located = residuals.len();
    let residual_p50 = percentile(&residuals, 50.0);
    let residual_p90 = percentile(&residuals, 90.0);
    let worst_residual_px = if residuals.is_empty() {
        None
    } else {
        residuals
            .iter()
            .cloned()
            .fold(None::<f64>, |acc, v| Some(acc.map_or(v, |a: f64| a.max(v))))
    };
    let passed = n > 0 && located == n && residual_p90.is_some_and(|p90| p90 <= threshold_px);
    Summary {
        n,
        located,
        locate_rate: if n == 0 {
            0.0
        } else {
            located as f64 / n as f64
        },
        residual_p50,
        residual_p90,
        worst_residual_px,
        threshold_px,
        passed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_target_grid_rejects_zero_cols_or_rows() {
        assert!(build_target_grid(100.0, 100.0, 0, 3, 0.1).is_err());
        assert!(build_target_grid(100.0, 100.0, 3, 0, 0.1).is_err());
    }

    #[test]
    fn build_target_grid_rejects_out_of_range_margin() {
        assert!(build_target_grid(100.0, 100.0, 3, 3, -0.1).is_err());
        assert!(build_target_grid(100.0, 100.0, 3, 3, 0.5).is_err());
    }

    #[test]
    fn build_target_grid_single_cell_is_the_midpoint() {
        let grid = build_target_grid(200.0, 100.0, 1, 1, 0.1).unwrap();
        assert_eq!(grid, vec![Point { x: 100.0, y: 50.0 }]);
    }

    #[test]
    fn build_target_grid_row_major_2x2_hits_the_margin_edges() {
        let grid = build_target_grid(100.0, 100.0, 2, 2, 0.1).unwrap();
        assert_eq!(grid.len(), 4);
        // margin = 10 on each side -> x0=10, x1=90; y0=10, y1=90
        assert_eq!(grid[0], Point { x: 10.0, y: 10.0 }); // row0, col0
        assert_eq!(grid[1], Point { x: 90.0, y: 10.0 }); // row0, col1
        assert_eq!(grid[2], Point { x: 10.0, y: 90.0 }); // row1, col0
        assert_eq!(grid[3], Point { x: 90.0, y: 90.0 }); // row1, col1
    }

    #[test]
    fn residual_px_is_euclidean_distance() {
        assert_eq!(
            residual_px(Point { x: 0.0, y: 0.0 }, Point { x: 3.0, y: 4.0 }),
            5.0
        );
    }

    #[test]
    fn pick_landed_cluster_none_when_no_clusters() {
        assert!(pick_landed_cluster(&[], Point { x: 0.0, y: 0.0 }).is_none());
    }

    #[test]
    fn pick_landed_cluster_picks_the_nearest_centroid() {
        let clusters = vec![
            ClusterCentroid {
                centroid_x: 100.0,
                centroid_y: 100.0,
                pixels: 50,
            }, // far
            ClusterCentroid {
                centroid_x: 12.0,
                centroid_y: 9.0,
                pixels: 20,
            }, // near
        ];
        let picked = pick_landed_cluster(&clusters, Point { x: 10.0, y: 10.0 }).unwrap();
        assert_eq!(picked.landed, Point { x: 12.0, y: 9.0 });
        assert!(
            (picked.residual_px
                - residual_px(Point { x: 12.0, y: 9.0 }, Point { x: 10.0, y: 10.0 }))
            .abs()
                < 1e-9
        );
    }

    #[test]
    fn percentile_empty_is_none() {
        assert_eq!(percentile(&[], 50.0), None);
    }

    #[test]
    fn percentile_p50_of_five_sorted_values() {
        let values = vec![5.0, 1.0, 3.0, 2.0, 4.0];
        assert_eq!(percentile(&values, 50.0), Some(3.0));
    }

    #[test]
    fn percentile_p90_nearest_rank() {
        let values: Vec<f64> = (1..=10).map(|v| v as f64).collect();
        // rank = ceil(0.9 * 10) = 9 -> index 8 -> value 9
        assert_eq!(percentile(&values, 90.0), Some(9.0));
    }

    fn trial(target: Point, landed: Option<Point>, residual: Option<f64>) -> TrialResult {
        TrialResult {
            target,
            landed,
            residual_px: residual,
        }
    }

    #[test]
    fn summarize_residuals_empty_results_fails() {
        let s = summarize_residuals(&[], 30.0);
        assert_eq!(s.n, 0);
        assert!(!s.passed);
        assert_eq!(s.locate_rate, 0.0);
    }

    #[test]
    fn summarize_residuals_passes_when_all_located_and_within_threshold() {
        let results = vec![
            trial(
                Point { x: 0.0, y: 0.0 },
                Some(Point { x: 1.0, y: 0.0 }),
                Some(1.0),
            ),
            trial(
                Point { x: 10.0, y: 10.0 },
                Some(Point { x: 12.0, y: 10.0 }),
                Some(2.0),
            ),
        ];
        let s = summarize_residuals(&results, 30.0);
        assert_eq!(s.n, 2);
        assert_eq!(s.located, 2);
        assert_eq!(s.locate_rate, 1.0);
        assert!(s.passed);
        assert_eq!(s.worst_residual_px, Some(2.0));
    }

    #[test]
    fn summarize_residuals_fails_on_a_single_blind_miss_even_if_others_are_perfect() {
        let results = vec![
            trial(
                Point { x: 0.0, y: 0.0 },
                Some(Point { x: 0.0, y: 0.0 }),
                Some(0.0),
            ),
            trial(Point { x: 10.0, y: 10.0 }, None, None), // blind miss
        ];
        let s = summarize_residuals(&results, 100.0);
        assert_eq!(s.located, 1);
        assert!(
            !s.passed,
            "a single unlocated target must fail the run regardless of threshold"
        );
    }

    #[test]
    fn summarize_residuals_fails_on_a_fat_tail_even_if_all_located() {
        let results = vec![
            trial(
                Point { x: 0.0, y: 0.0 },
                Some(Point { x: 0.0, y: 0.0 }),
                Some(1.0),
            ),
            trial(
                Point { x: 10.0, y: 10.0 },
                Some(Point { x: 60.0, y: 10.0 }),
                Some(50.0),
            ), // fat tail
        ];
        let s = summarize_residuals(&results, 30.0);
        assert_eq!(s.located, 2);
        assert!(
            !s.passed,
            "a fat-tail residual over threshold must fail even with 100% locate rate"
        );
    }
}
