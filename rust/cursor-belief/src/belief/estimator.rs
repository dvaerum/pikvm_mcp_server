//! `CursorBelief` itself: the Kalman-style predict/observe state machine,
//! plus its unit and end-to-end integration tests.

use std::time::{SystemTime, UNIX_EPOCH};

use super::types::{
    Axes, BeliefEdges, BeliefRegion, Bounds, CursorBeliefOptions, Emit, LastEmit, ObserveOptions,
    Point, RatioClamp, RatioState, Variance, WouldRejectOptions,
};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_millis() as u64
}

pub struct CursorBelief {
    pub position: Point,
    pub velocity: Point,
    variance: Variance,
    ratio: RatioState,
    pub bounds: Option<Bounds>,
    pub last_update_ms: u64,

    process_noise_scale: f64,
    edge_clip_variance: f64,
    ratio_clamp_min: f64,
    ratio_clamp_max: f64,

    last_emit: Option<LastEmit>,
    last_observation: Option<Point>,
    emit_mag_since_last_observation: f64,
}

impl CursorBelief {
    pub fn new(opts: CursorBeliefOptions) -> Self {
        let v0 = opts.initial_position_variance.unwrap_or(25.0);
        let r_prior = opts.ratio_prior.unwrap_or(Axes { x: 1.3, y: 1.3 });
        let r_var = opts.ratio_variance_prior.unwrap_or(Axes { x: 0.1, y: 0.1 });
        let ratio_clamp = opts
            .ratio_clamp
            .unwrap_or(RatioClamp { min: 0.5, max: 3.0 });
        Self {
            position: opts.initial_position,
            velocity: Point { x: 0.0, y: 0.0 },
            variance: Variance {
                x: v0,
                y: v0,
                vx: 1.0,
                vy: 1.0,
            },
            ratio: RatioState {
                x: r_prior.x,
                y: r_prior.y,
                vx: r_var.x,
                vy: r_var.y,
            },
            bounds: opts.bounds,
            last_update_ms: now_ms(),
            process_noise_scale: opts.process_noise_scale.unwrap_or(0.5),
            edge_clip_variance: opts.edge_clip_variance.unwrap_or(100.0),
            ratio_clamp_min: ratio_clamp.min,
            ratio_clamp_max: ratio_clamp.max,
            last_emit: None,
            last_observation: None,
            emit_mag_since_last_observation: 0.0,
        }
    }

    /// Expose the current per-axis ratio belief (mean px/mickey). The TS
    /// side reads this straight off the public `ratio.x`/`ratio.y` fields;
    /// `RatioState` stays private here since callers only ever need the
    /// mean, not the internal variance (`kalman_update_ratio`'s domain).
    pub fn ratio_mean(&self) -> Axes {
        Axes {
            x: self.ratio.x,
            y: self.ratio.y,
        }
    }

    /// Expose the current per-axis position variance (px²). Same rationale
    /// as `ratio_mean` — the TS side reads `belief.variance.x`/`.y` directly
    /// off the public field; the `vx`/`vy` slots are vestigial (set at
    /// construction/reset, never otherwise touched by either port) so
    /// aren't exposed.
    pub fn variance(&self) -> Axes {
        Axes {
            x: self.variance.x,
            y: self.variance.y,
        }
    }

    /// Query whether `measurement` looks like a static-feature lock-in
    /// repeat of the last accepted observation. Pure/non-mutating.
    pub fn would_reject_as_stationary(
        &self,
        measurement: Point,
        opts: Option<WouldRejectOptions>,
    ) -> bool {
        let Some(last) = self.last_observation else {
            return false;
        };
        let opts = opts.unwrap_or_default();
        let drift_px = opts.drift_px.unwrap_or(5.0);
        let min_emit = opts.min_emit_mickeys.unwrap_or(30.0);
        let drift = ((measurement.x - last.x).powi(2) + (measurement.y - last.y).powi(2)).sqrt();
        drift < drift_px && self.emit_mag_since_last_observation >= min_emit
    }

    /// Forward-predict the belief by an emit. Position += emit · ratio,
    /// variance grows by process noise + ratio uncertainty contribution.
    /// If the predicted position projects past a bound, the position is
    /// clamped to the edge and the clipped-axis variance is inflated.
    pub fn predict(&mut self, emit: Emit, now_ms_override: Option<u64>) {
        let t = now_ms_override.unwrap_or_else(now_ms);
        // Snapshot pre-emit position so a later observe() can compute live
        // ratio honestly even after the position has been Kalman-updated.
        let pre_pos_x = self.position.x;
        let pre_pos_y = self.position.y;
        let new_x = self.position.x + emit.dx * self.ratio.x;
        let new_y = self.position.y + emit.dy * self.ratio.y;

        let adx = emit.dx.abs();
        let ady = emit.dy.abs();
        let mut new_var_x =
            self.variance.x + self.process_noise_scale * adx + self.ratio.vx * adx * adx;
        let mut new_var_y =
            self.variance.y + self.process_noise_scale * ady + self.ratio.vy * ady * ady;

        let mut clipped_x = false;
        let mut clipped_y = false;
        if let Some(bounds) = self.bounds {
            let min_x = bounds.x;
            let max_x = bounds.x + bounds.width;
            let min_y = bounds.y;
            let max_y = bounds.y + bounds.height;
            let final_x = new_x.max(min_x).min(max_x);
            let final_y = new_y.max(min_y).min(max_y);
            if final_x != new_x {
                clipped_x = true;
                new_var_x += self.edge_clip_variance;
            }
            if final_y != new_y {
                clipped_y = true;
                new_var_y += self.edge_clip_variance;
            }
            self.position.x = final_x;
            self.position.y = final_y;
        } else {
            self.position.x = new_x;
            self.position.y = new_y;
        }

        self.variance.x = new_var_x;
        self.variance.y = new_var_y;
        self.last_update_ms = t;

        self.last_emit = Some(LastEmit {
            dx: emit.dx,
            dy: emit.dy,
            clipped_x,
            clipped_y,
            pre_pos_x,
            pre_pos_y,
        });

        self.emit_mag_since_last_observation += (emit.dx * emit.dx + emit.dy * emit.dy).sqrt();
    }

    /// Observe the cursor's measured position and update the belief via
    /// Kalman gain. `confidence` ∈ [0, 1]: 1 = perfect measurement, 0 =
    /// ignore. If a recent emit is on record (from `predict`), the
    /// observation also updates the ratio belief.
    pub fn observe(
        &mut self,
        measurement: Point,
        confidence: f64,
        opts: Option<ObserveOptions>,
    ) -> bool {
        if confidence <= 0.0 || !confidence.is_finite() {
            return false;
        }
        let opts = opts.unwrap_or_default();
        if opts.reject_stationary
            && self.would_reject_as_stationary(
                measurement,
                Some(WouldRejectOptions {
                    drift_px: opts.stationary_drift_px,
                    min_emit_mickeys: opts.stationary_min_emit_mickeys,
                }),
            )
        {
            return false;
        }
        let c = confidence.min(1.0);
        let r = Self::observation_noise(c);
        self.kalman_update_position(measurement, r);
        if let Some(last_emit) = self.last_emit {
            if last_emit.dx != 0.0 || last_emit.dy != 0.0 {
                self.kalman_update_ratio(measurement, c);
            }
        }
        self.last_observation = Some(measurement);
        self.emit_mag_since_last_observation = 0.0;
        true
    }

    /// Return the search region the caller should bias detection toward.
    /// Radii are scaled to a 1D Gaussian quantile so a 95% region is
    /// roughly ±1.96σ.
    pub fn expected_region(&self, confidence: Option<f64>) -> BeliefRegion {
        let confidence = confidence.unwrap_or(0.95);
        let z = Self::inv_normal_quantile(0.5 + confidence / 2.0);
        let sigma_x = self.variance.x.sqrt();
        let sigma_y = self.variance.y.sqrt();
        BeliefRegion {
            cx: self.position.x,
            cy: self.position.y,
            rx: z * sigma_x,
            ry: z * sigma_y,
        }
    }

    /// Per-edge boolean: is the cursor within `threshold` px of each of
    /// the four bounds? All-false when no bounds are known.
    pub fn is_at_edge(&self, threshold: Option<f64>) -> BeliefEdges {
        let threshold = threshold.unwrap_or(10.0);
        let Some(bounds) = self.bounds else {
            return BeliefEdges {
                north: false,
                south: false,
                east: false,
                west: false,
            };
        };
        let min_x = bounds.x;
        let max_x = bounds.x + bounds.width;
        let min_y = bounds.y;
        let max_y = bounds.y + bounds.height;
        BeliefEdges {
            west: self.position.x - min_x <= threshold,
            east: max_x - self.position.x <= threshold,
            north: self.position.y - min_y <= threshold,
            south: max_y - self.position.y <= threshold,
        }
    }

    /// Replace state with a known observation. Used after slam,
    /// locateCursor probe, or template seed — anywhere we have ground
    /// truth and want to discard the running belief. `confidence` is
    /// accepted but ignored (reset is unconditional), matching the TS
    /// signature's `void confidence` — kept as a parameter so call sites
    /// that pass one (mirroring the original's optional-with-default arg)
    /// still compile.
    pub fn reset(&mut self, observation: Point, _confidence: Option<f64>) {
        self.position = observation;
        self.velocity = Point { x: 0.0, y: 0.0 };
        // Tight position variance after reset; ratio belief preserved
        // (calibration we've learned shouldn't be discarded just because
        // we re-anchored position).
        self.variance.x = 1.0;
        self.variance.y = 1.0;
        self.variance.vx = 1.0;
        self.variance.vy = 1.0;
        self.last_update_ms = now_ms();
        self.last_emit = None;
        self.last_observation = Some(observation);
        self.emit_mag_since_last_observation = 0.0;
    }

    // -- internals --------------------------------------------------------

    /// Map a confidence c ∈ (0, 1] to observation noise variance. Lower
    /// confidence → larger R → less weight on the measurement.
    fn observation_noise(c: f64) -> f64 {
        1.0 / (c * c)
    }

    fn kalman_update_position(&mut self, measurement: Point, r: f64) {
        let px = self.variance.x;
        let kx = px / (px + r);
        self.position.x += kx * (measurement.x - self.position.x);
        self.variance.x = (1.0 - kx) * px;

        let py = self.variance.y;
        let ky = py / (py + r);
        self.position.y += ky * (measurement.y - self.position.y);
        self.variance.y = (1.0 - ky) * py;
    }

    fn kalman_update_ratio(&mut self, measurement: Point, c: f64) {
        let Some(last) = self.last_emit else { return };
        if last.dx != 0.0 && !last.clipped_x {
            let live_ratio = (measurement.x - last.pre_pos_x) / last.dx;
            self.update_ratio_axis(Axis::X, live_ratio, c);
        }
        if last.dy != 0.0 && !last.clipped_y {
            let live_ratio = (measurement.y - last.pre_pos_y) / last.dy;
            self.update_ratio_axis(Axis::Y, live_ratio, c);
        }
    }

    fn update_ratio_axis(&mut self, axis: Axis, live_ratio: f64, c: f64) {
        if !live_ratio.is_finite() {
            return;
        }
        // Clamp insane live ratios so a single noisy observation can't
        // collapse the ratio to 0.1 or 30.
        let clamped = live_ratio
            .max(self.ratio_clamp_min)
            .min(self.ratio_clamp_max);
        let r = Self::observation_noise(c);
        match axis {
            Axis::X => {
                let p = self.ratio.vx;
                let k = p / (p + r);
                self.ratio.x += k * (clamped - self.ratio.x);
                self.ratio.vx = (1.0 - k) * p;
            }
            Axis::Y => {
                let p = self.ratio.vy;
                let k = p / (p + r);
                self.ratio.y += k * (clamped - self.ratio.y);
                self.ratio.vy = (1.0 - k) * p;
            }
        }
    }

    /// Approximate inverse normal CDF for p ∈ (0.5, 1). Beasley-Springer-
    /// Moro polynomial — 4-decimal accuracy.
    fn inv_normal_quantile(p: f64) -> f64 {
        if p <= 0.5 {
            return 0.0;
        }
        if p >= 1.0 {
            return 6.0;
        }
        let x = p - 0.5;
        if x.abs() <= 0.42 {
            let r = x * x;
            let num = ((-25.44106 * r + 41.39119) * r - 18.61500) * r + 2.50663;
            let den = (((3.13083 * r - 21.06224) * r + 23.08337) * r - 8.47351) * r + 1.0;
            return x * num / den;
        }
        let mut r = 1.0 - p;
        if r <= 0.0 {
            return 6.0;
        }
        r = (-r.ln()).ln();
        1.0 + r * (0.4361836 + r * (-0.1201676 + r * 0.1393820))
    }
}

#[derive(Clone, Copy)]
enum Axis {
    X,
    Y,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(initial: Point) -> CursorBeliefOptions {
        CursorBeliefOptions::new(initial)
    }

    fn pt(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    mod construction {
        use super::*;

        #[test]
        fn initializes_at_the_given_position_with_the_given_confidence() {
            let b = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(1.0),
                ..opts(pt(500.0, 400.0))
            });
            assert_eq!(b.position, pt(500.0, 400.0));
            assert!((b.variance.x - 1.0).abs() < 1e-3);
            assert!((b.variance.y - 1.0).abs() < 1e-3);
        }

        #[test]
        fn seeds_ratio_prior_from_a_calibrated_value() {
            let b = CursorBelief::new(CursorBeliefOptions {
                ratio_prior: Some(Axes { x: 1.4, y: 1.6 }),
                ..opts(pt(0.0, 0.0))
            });
            let r = b.ratio_mean();
            assert!((r.x - 1.4).abs() < 1e-3);
            assert!((r.y - 1.6).abs() < 1e-3);
        }

        #[test]
        fn falls_back_to_the_documented_ipad_default_ratio_when_none_given() {
            let b = CursorBelief::new(opts(pt(0.0, 0.0)));
            let r = b.ratio_mean();
            assert!((r.x - 1.3).abs() < 1e-3);
            assert!((r.y - 1.3).abs() < 1e-3);
        }
    }

    mod predict_forward_propagation {
        use super::*;

        #[test]
        fn moves_position_by_emit_times_ratio_mean_per_axis() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                ratio_prior: Some(Axes { x: 1.5, y: 1.5 }),
                ..opts(pt(100.0, 100.0))
            });
            b.predict(Emit { dx: 20.0, dy: 0.0 }, None);
            assert!((b.position.x - (100.0 + 20.0 * 1.5)).abs() < 0.1);
            assert!((b.position.y - 100.0).abs() < 0.1);
        }

        #[test]
        fn handles_negative_emits_sign_preserving() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                ratio_prior: Some(Axes { x: 1.5, y: 1.5 }),
                ..opts(pt(500.0, 500.0))
            });
            b.predict(
                Emit {
                    dx: -10.0,
                    dy: -10.0,
                },
                None,
            );
            assert!((b.position.x - 485.0).abs() < 0.1);
            assert!((b.position.y - 485.0).abs() < 0.1);
        }

        #[test]
        fn zero_emit_leaves_position_unchanged_but_advances_time() {
            let mut b = CursorBelief::new(opts(pt(100.0, 100.0)));
            let t0 = b.last_update_ms;
            b.predict(Emit { dx: 0.0, dy: 0.0 }, Some(t0 + 100));
            assert_eq!(b.position, pt(100.0, 100.0));
            assert_eq!(b.last_update_ms, t0 + 100);
        }

        #[test]
        fn widens_position_variance_with_emit_magnitude_process_noise() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(1.0),
                ..opts(pt(0.0, 0.0))
            });
            let before = b.variance.x;
            b.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            assert!(b.variance.x > before);
        }

        #[test]
        fn larger_emits_add_proportionally_more_variance() {
            let mut a = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(1.0),
                ..opts(pt(0.0, 0.0))
            });
            let mut c = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(1.0),
                ..opts(pt(0.0, 0.0))
            });
            a.predict(Emit { dx: 10.0, dy: 0.0 }, None);
            c.predict(Emit { dx: 100.0, dy: 0.0 }, None);
            assert!(c.variance.x > a.variance.x);
        }

        #[test]
        fn ratio_variance_contributes_to_position_variance() {
            let mut certain = CursorBelief::new(CursorBeliefOptions {
                ratio_prior: Some(Axes { x: 1.3, y: 1.3 }),
                ratio_variance_prior: Some(Axes {
                    x: 0.0001,
                    y: 0.0001,
                }),
                ..opts(pt(0.0, 0.0))
            });
            let mut uncertain = CursorBelief::new(CursorBeliefOptions {
                ratio_prior: Some(Axes { x: 1.3, y: 1.3 }),
                ratio_variance_prior: Some(Axes { x: 0.5, y: 0.5 }),
                ..opts(pt(0.0, 0.0))
            });
            certain.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            uncertain.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            assert!(uncertain.variance.x > certain.variance.x);
        }
    }

    mod clip_to_bounds_with_variance_inflation {
        use super::*;

        fn bounds() -> Bounds {
            Bounds {
                x: 0.0,
                y: 0.0,
                width: 1000.0,
                height: 800.0,
            }
        }

        #[test]
        fn clips_predicted_x_to_bounds_when_emit_would_project_past_right_edge() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(990.0, 400.0))
            });
            b.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            assert_eq!(b.position.x, 1000.0);
        }

        #[test]
        fn inflates_the_clipped_axis_variance() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(4.0),
                bounds: Some(bounds()),
                ..opts(pt(990.0, 400.0))
            });
            let x_var_before = b.variance.x;
            b.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            assert!(b.variance.x > x_var_before);
        }

        #[test]
        fn does_not_inflate_the_perpendicular_axis_when_only_one_axis_clips() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(4.0),
                bounds: Some(bounds()),
                ..opts(pt(990.0, 400.0))
            });
            b.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            let y_var_after = b.variance.y;
            assert!(b.variance.x > y_var_after);
        }

        #[test]
        fn clips_on_every_edge() {
            let mut r = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(990.0, 400.0))
            });
            r.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            assert_eq!(r.position.x, 1000.0);

            let mut l = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(10.0, 400.0))
            });
            l.predict(Emit { dx: -50.0, dy: 0.0 }, None);
            assert_eq!(l.position.x, 0.0);

            let mut t = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(500.0, 10.0))
            });
            t.predict(Emit { dx: 0.0, dy: -50.0 }, None);
            assert_eq!(t.position.y, 0.0);

            let mut bo = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(500.0, 790.0))
            });
            bo.predict(Emit { dx: 0.0, dy: 50.0 }, None);
            assert_eq!(bo.position.y, 800.0);
        }

        #[test]
        fn without_bounds_predicts_past_screen_positions_without_clipping() {
            let mut b = CursorBelief::new(opts(pt(990.0, 400.0)));
            b.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            assert!(b.position.x > 1000.0);
        }
    }

    mod observe_bayesian_correction {
        use super::*;

        #[test]
        fn high_confidence_observation_tightens_variance() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(100.0),
                ..opts(pt(100.0, 100.0))
            });
            b.observe(pt(150.0, 150.0), 1.0, None);
            assert!(b.variance.x < 100.0);
            assert!(b.position.x > 100.0);
            assert!(b.position.x <= 150.0);
        }

        #[test]
        fn low_confidence_observation_barely_moves_the_mean() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(1.0),
                ..opts(pt(100.0, 100.0))
            });
            b.observe(pt(200.0, 200.0), 0.01, None);
            assert!(b.position.x < 110.0);
        }

        #[test]
        fn confidence_zero_means_no_update_at_all() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(10.0),
                ..opts(pt(100.0, 100.0))
            });
            b.observe(pt(200.0, 200.0), 0.0, None);
            assert_eq!(b.position, pt(100.0, 100.0));
            assert_eq!(b.variance.x, 10.0);
        }

        #[test]
        fn multiple_consistent_observations_converge_the_mean_tighter() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(100.0),
                ..opts(pt(0.0, 0.0))
            });
            for _ in 0..10 {
                b.observe(pt(500.0, 500.0), 0.8, None);
            }
            assert!((b.position.x - 500.0).abs() < 2.0);
            assert!(b.variance.x < 10.0);
        }
    }

    mod expected_region_search_window_provider {
        use super::*;

        #[test]
        fn returns_a_region_centred_on_the_current_position() {
            let b = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(25.0),
                ..opts(pt(500.0, 400.0))
            });
            let r = b.expected_region(None);
            assert_eq!(r.cx, 500.0);
            assert_eq!(r.cy, 400.0);
        }

        #[test]
        fn region_radius_scales_with_variance() {
            let tight = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(1.0),
                ..opts(pt(0.0, 0.0))
            });
            let wide = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(100.0),
                ..opts(pt(0.0, 0.0))
            });
            let tr = tight.expected_region(None);
            let wr = wide.expected_region(None);
            assert!(wr.rx > tr.rx);
        }

        #[test]
        fn a_95_percent_confidence_region_is_roughly_2sigma_wide() {
            let b = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(100.0),
                ..opts(pt(0.0, 0.0))
            });
            let r = b.expected_region(Some(0.95));
            assert!(r.rx > 15.0);
            assert!(r.rx < 25.0);
        }
    }

    mod is_at_edge {
        use super::*;

        fn bounds() -> Bounds {
            Bounds {
                x: 0.0,
                y: 0.0,
                width: 1000.0,
                height: 800.0,
            }
        }

        #[test]
        fn returns_all_false_when_cursor_is_in_the_interior() {
            let b = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(500.0, 400.0))
            });
            assert_eq!(
                b.is_at_edge(None),
                BeliefEdges {
                    north: false,
                    south: false,
                    east: false,
                    west: false
                }
            );
        }

        #[test]
        fn detects_east_edge() {
            let b = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(995.0, 400.0))
            });
            assert!(b.is_at_edge(None).east);
        }

        #[test]
        fn detects_all_four_edges_independently() {
            let e = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(999.0, 400.0))
            });
            let edges = e.is_at_edge(None);
            assert!(edges.east && !edges.west && !edges.north && !edges.south);

            let w = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(1.0, 400.0))
            });
            let edges = w.is_at_edge(None);
            assert!(!edges.east && edges.west);

            let n = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(500.0, 1.0))
            });
            assert!(n.is_at_edge(None).north);

            let s = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(500.0, 799.0))
            });
            assert!(s.is_at_edge(None).south);
        }

        #[test]
        fn detects_two_edges_simultaneously_when_in_a_corner() {
            let b = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(999.0, 799.0))
            });
            let edges = b.is_at_edge(None);
            assert!(edges.east && edges.south);
        }

        #[test]
        fn returns_all_false_when_no_bounds_set() {
            let b = CursorBelief::new(opts(pt(999.0, 999.0)));
            assert_eq!(
                b.is_at_edge(None),
                BeliefEdges {
                    north: false,
                    south: false,
                    east: false,
                    west: false
                }
            );
        }

        #[test]
        fn uses_a_configurable_edge_threshold() {
            let b = CursorBelief::new(CursorBeliefOptions {
                bounds: Some(bounds()),
                ..opts(pt(985.0, 400.0))
            });
            assert!(!b.is_at_edge(Some(5.0)).east); // 15px away from edge
            assert!(b.is_at_edge(Some(20.0)).east); // within threshold
        }
    }

    mod reset_collapse_to_known_observation {
        use super::*;

        #[test]
        fn replaces_position_with_the_observation_and_tightens_variance() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                initial_position_variance: Some(1000.0),
                ..opts(pt(0.0, 0.0))
            });
            b.reset(pt(500.0, 500.0), None);
            assert_eq!(b.position, pt(500.0, 500.0));
            assert!(b.variance.x < 10.0);
        }

        #[test]
        fn zeros_velocity() {
            let mut b = CursorBelief::new(opts(pt(0.0, 0.0)));
            b.reset(pt(100.0, 100.0), None);
            assert_eq!(b.velocity.x, 0.0);
            assert_eq!(b.velocity.y, 0.0);
        }
    }

    mod ratio_learning_live_px_per_mickey_update {
        use super::*;

        #[test]
        fn observe_after_emit_refines_the_ratio_estimate() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                ratio_prior: Some(Axes { x: 1.3, y: 1.3 }),
                ratio_variance_prior: Some(Axes { x: 0.5, y: 0.5 }),
                ..opts(pt(0.0, 0.0))
            });
            let ratio_before = b.ratio_mean().x;
            b.predict(Emit { dx: 100.0, dy: 0.0 }, None);
            b.observe(pt(170.0, 0.0), 0.9, None);
            assert!(b.ratio_mean().x > ratio_before);
        }

        #[test]
        fn repeated_consistent_observations_converge_ratio_toward_truth() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                ratio_prior: Some(Axes { x: 1.3, y: 1.3 }),
                ratio_variance_prior: Some(Axes { x: 0.5, y: 0.5 }),
                ..opts(pt(0.0, 0.0))
            });
            for _ in 0..10 {
                let start_x = b.position.x;
                b.predict(Emit { dx: 50.0, dy: 0.0 }, None);
                // Ground truth: every 50 mickey emit moves the cursor exactly 75 px (ratio 1.5).
                b.observe(pt(start_x + 75.0, 0.0), 0.95, None);
            }
            assert!((b.ratio_mean().x - 1.5).abs() < 0.5);
        }

        #[test]
        fn clamps_insanely_low_live_ratio_so_a_noisy_observation_does_not_corrupt_belief() {
            let mut b = CursorBelief::new(CursorBeliefOptions {
                ratio_prior: Some(Axes { x: 1.3, y: 1.3 }),
                ..opts(pt(0.0, 0.0))
            });
            b.predict(Emit { dx: 100.0, dy: 0.0 }, None);
            // Pathological: cursor "moved" only 10 px (live ratio 0.1).
            b.observe(pt(10.0, 0.0), 0.9, None);
            assert!(b.ratio_mean().x > 0.5);
        }
    }

    // Phase 212 — stationary-cluster rejection
    mod stationary_cluster_rejection {
        use super::*;

        #[test]
        fn observe_returns_true_on_first_acceptance_and_updates_belief() {
            let mut b = CursorBelief::new(opts(pt(0.0, 0.0)));
            let accepted = b.observe(pt(100.0, 100.0), 0.9, None);
            assert!(accepted);
            assert!(b.position.x > 50.0);
        }

        #[test]
        fn would_reject_as_stationary_returns_false_before_any_observation() {
            let b = CursorBelief::new(opts(pt(0.0, 0.0)));
            assert!(!b.would_reject_as_stationary(pt(50.0, 50.0), None));
        }

        #[test]
        fn would_reject_as_stationary_returns_false_when_no_emit_happened_between_observations() {
            let mut b = CursorBelief::new(opts(pt(0.0, 0.0)));
            b.observe(pt(100.0, 100.0), 0.9, None);
            assert!(!b.would_reject_as_stationary(pt(100.0, 100.0), None));
        }

        #[test]
        fn would_reject_as_stationary_returns_true_when_same_pixel_returned_after_a_real_emit() {
            let mut b = CursorBelief::new(opts(pt(0.0, 0.0)));
            b.observe(pt(970.0, 771.0), 0.9, None);
            b.predict(Emit { dx: 50.0, dy: 0.0 }, None); // 50 mickeys ≥ 30 threshold
            assert!(b.would_reject_as_stationary(pt(970.0, 771.0), None));
        }

        #[test]
        fn would_reject_as_stationary_respects_drift_px_threshold() {
            let mut b = CursorBelief::new(opts(pt(0.0, 0.0)));
            b.observe(pt(970.0, 771.0), 0.9, None);
            b.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            // 6 px drift (default threshold is 5) — outside the lock-in window.
            assert!(!b.would_reject_as_stationary(pt(976.0, 771.0), None));
            // Within 5 px — locked in.
            assert!(b.would_reject_as_stationary(pt(973.0, 773.0), None));
        }

        #[test]
        fn would_reject_as_stationary_respects_min_emit_mickeys_threshold() {
            let mut b = CursorBelief::new(opts(pt(0.0, 0.0)));
            b.observe(pt(970.0, 771.0), 0.9, None);
            b.predict(Emit { dx: 10.0, dy: 0.0 }, None); // 10 mickeys < default 30 → no rejection
            assert!(!b.would_reject_as_stationary(pt(970.0, 771.0), None));
            b.predict(Emit { dx: 25.0, dy: 0.0 }, None); // cumulative 35 ≥ 30 → rejection
            assert!(b.would_reject_as_stationary(pt(970.0, 771.0), None));
        }

        #[test]
        fn observe_with_reject_stationary_false_default_does_not_gate() {
            let mut b = CursorBelief::new(opts(pt(0.0, 0.0)));
            b.observe(pt(970.0, 771.0), 0.9, None);
            b.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            let accepted = b.observe(pt(970.0, 771.0), 0.9, None);
            assert!(accepted);
        }

        #[test]
        fn observe_with_reject_stationary_true_returns_false_on_lock_in_and_does_not_update_belief()
        {
            let mut b = CursorBelief::new(opts(pt(970.0, 771.0)));
            b.observe(pt(970.0, 771.0), 0.9, None);
            b.predict(Emit { dx: 50.0, dy: 0.0 }, None); // belief moves to ~1035
            let x_after_predict = b.position.x;
            let accepted = b.observe(
                pt(970.0, 771.0),
                0.9,
                Some(ObserveOptions {
                    reject_stationary: true,
                    ..Default::default()
                }),
            );
            assert!(!accepted);
            // Position should NOT have been pulled back to 970 — the
            // rejected observation has zero influence on belief.
            assert_eq!(b.position.x, x_after_predict);
        }

        #[test]
        fn observe_accepts_a_measurement_that_has_clearly_moved_after_an_emit() {
            let mut b = CursorBelief::new(opts(pt(0.0, 0.0)));
            b.observe(pt(970.0, 771.0), 0.9, None);
            b.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            let accepted = b.observe(
                pt(1035.0, 770.0),
                0.9,
                Some(ObserveOptions {
                    reject_stationary: true,
                    ..Default::default()
                }),
            );
            assert!(accepted);
        }

        #[test]
        fn emit_accumulator_resets_on_accepted_observation() {
            let mut b = CursorBelief::new(opts(pt(0.0, 0.0)));
            b.observe(pt(100.0, 100.0), 0.9, None);
            b.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            b.observe(pt(165.0, 100.0), 0.9, None); // accept — accumulator resets
                                                    // Now a smaller emit should NOT re-trigger rejection just
                                                    // because the prior emit accumulated past 30.
            b.predict(Emit { dx: 5.0, dy: 0.0 }, None);
            assert!(!b.would_reject_as_stationary(pt(165.0, 100.0), None));
        }

        #[test]
        fn reset_clears_the_stationary_cluster_history() {
            let mut b = CursorBelief::new(opts(pt(0.0, 0.0)));
            b.observe(pt(970.0, 771.0), 0.9, None);
            b.predict(Emit { dx: 50.0, dy: 0.0 }, None);
            // Without reset, this would be rejected.
            b.reset(pt(500.0, 500.0), None);
            assert!(!b.would_reject_as_stationary(pt(970.0, 771.0), None));
        }

        #[test]
        fn configurable_thresholds_via_options() {
            let mut b = CursorBelief::new(opts(pt(0.0, 0.0)));
            b.observe(pt(970.0, 771.0), 0.9, None);
            b.predict(Emit { dx: 100.0, dy: 0.0 }, None);
            // Tighter drift threshold (3 px) — 4 px counts as moved.
            assert!(!b.would_reject_as_stationary(
                pt(974.0, 771.0),
                Some(WouldRejectOptions {
                    drift_px: Some(3.0),
                    ..Default::default()
                })
            ));
            // Higher emit threshold (200) — 100 mickeys is too few to expect motion.
            assert!(!b.would_reject_as_stationary(
                pt(970.0, 771.0),
                Some(WouldRejectOptions {
                    min_emit_mickeys: Some(200.0),
                    ..Default::default()
                })
            ));
        }
    }
}

/// End-to-end integration tests for `CursorBelief`. Faithful port of
/// `src/pikvm/__tests__/cursor-belief-integration.test.ts`.
///
/// These simulate emit/observe sequences against synthetic "ground truth"
/// trajectories and verify the belief converges to the truth and inflates
/// variance correctly when observations are sparse or absent. The belief
/// never sees the truth directly — only emits and noisy observations.
#[cfg(test)]
mod integration_tests {
    use super::*;

    /// Box-Muller-ish noise — deterministic with seed for reproducibility.
    /// Faithful port of the TS `makeNoise`: a linear-congruential generator
    /// (multiplier 9301, increment 49297, modulus 233280) feeding a
    /// Box-Muller transform. Values stay small enough that `i64`
    /// multiplication is exact (mirrors JS's exact-integer f64 arithmetic
    /// here), so the sequence matches the TS original bit-for-bit given
    /// the same seed.
    struct Noise {
        s: i64,
    }

    impl Noise {
        fn new(seed: i64) -> Self {
            Self { s: seed }
        }

        fn next(&mut self) -> f64 {
            self.s = (self.s * 9301 + 49297) % 233280;
            let u = self.s as f64 / 233280.0;
            self.s = (self.s * 9301 + 49297) % 233280;
            let v = self.s as f64 / 233280.0;
            (-2.0 * (u + 1e-9).ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
        }
    }

    struct SyntheticGroundTruth {
        position: Point,
        true_ratio: Axes,
        bounds: Option<Bounds>,
    }

    impl SyntheticGroundTruth {
        fn new(start: Point, ratio: Axes, bounds: Option<Bounds>) -> Self {
            Self {
                position: start,
                true_ratio: ratio,
                bounds,
            }
        }

        fn emit(&mut self, dx: f64, dy: f64) {
            self.position.x += dx * self.true_ratio.x;
            self.position.y += dy * self.true_ratio.y;
            if let Some(b) = self.bounds {
                self.position.x = self.position.x.max(b.x).min(b.x + b.width);
                self.position.y = self.position.y.max(b.y).min(b.y + b.height);
            }
        }

        fn observe(&self, noise_std: f64, noise: &mut Noise) -> Point {
            Point {
                x: self.position.x + noise.next() * noise_std,
                y: self.position.y + noise.next() * noise_std,
            }
        }
    }

    #[test]
    fn converges_to_ground_truth_across_20_emit_observe_cycles_with_noisy_observations() {
        let mut truth =
            SyntheticGroundTruth::new(Point { x: 100.0, y: 100.0 }, Axes { x: 1.5, y: 1.5 }, None);
        let mut belief = CursorBelief::new(CursorBeliefOptions {
            initial_position_variance: Some(25.0),
            ratio_prior: Some(Axes { x: 1.3, y: 1.3 }), // wrong on purpose — should learn the truth
            ratio_variance_prior: Some(Axes { x: 0.3, y: 0.3 }),
            ..CursorBeliefOptions::new(Point { x: 100.0, y: 100.0 })
        });
        let mut noise = Noise::new(42);
        for i in 0..20 {
            let dx = if i % 2 == 0 { 30.0 } else { -20.0 };
            let dy = if i % 3 == 0 { 20.0 } else { -10.0 };
            truth.emit(dx, dy);
            belief.predict(Emit { dx, dy }, None);
            let obs = truth.observe(2.0, &mut noise);
            belief.observe(obs, 0.9, None);
        }
        // Belief position should be within ~5 px of ground truth.
        assert!((belief.position.x - truth.position.x).abs() < 5.0);
        assert!((belief.position.y - truth.position.y).abs() < 5.0);
        // Belief ratio should have moved toward 1.5 from the wrong 1.3 prior.
        let ratio = belief.ratio_mean();
        assert!(ratio.x > 1.4);
        assert!(ratio.x < 1.6);
    }

    #[test]
    fn emit_into_edge_inflates_clipped_axis_variance_without_diverging_the_perpendicular_axis() {
        let bounds = Bounds {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 800.0,
        };
        let mut truth = SyntheticGroundTruth::new(
            Point { x: 990.0, y: 400.0 },
            Axes { x: 1.5, y: 1.5 },
            Some(bounds),
        );
        let mut belief = CursorBelief::new(CursorBeliefOptions {
            initial_position_variance: Some(4.0), // start tight
            bounds: Some(bounds),
            ..CursorBeliefOptions::new(Point { x: 990.0, y: 400.0 })
        });
        let y_var_baseline = belief.variance().y;
        // Push hard against the right edge 10 times.
        for _ in 0..10 {
            truth.emit(50.0, 0.0); // truth clamps at x=1000
            belief.predict(Emit { dx: 50.0, dy: 0.0 }, None); // belief should clamp + inflate X variance
                                                              // No observation — we want to see how belief evolves with predict-only.
        }
        // Belief X should be at the right edge.
        assert_eq!(belief.position.x, 1000.0);
        // X variance should have grown massively from accumulated edge-clip
        // inflation across 10 predicts.
        assert!(belief.variance().x > 100.0);
        // Y variance should be roughly unchanged (no Y emit, no clipping).
        assert!(belief.variance().y < y_var_baseline * 5.0);
    }

    #[test]
    fn after_a_long_predict_only_run_an_observation_collapses_the_wide_belief_tight_again() {
        let mut belief = CursorBelief::new(CursorBeliefOptions {
            initial_position_variance: Some(4.0),
            ..CursorBeliefOptions::new(Point { x: 0.0, y: 0.0 })
        });
        // Predict-only — variance grows.
        for _ in 0..20 {
            belief.predict(Emit { dx: 30.0, dy: 30.0 }, None);
        }
        assert!(belief.variance().x > 50.0);
        // One high-confidence observation should pull variance back down.
        let pos = belief.position;
        belief.observe(pos, 1.0, None);
        assert!(belief.variance().x < 10.0);
    }

    #[test]
    fn phase_192_trajectory_replay_cursor_pinned_at_right_edge_then_unstuck_via_opposite_direction_emits(
    ) {
        // Replay the live trajectory observation: cursor was pinned at
        // ~(1118, 1010) on a 1170×1010 iPad area. Pushing east does
        // nothing; pushing west should unclamp with predicted ratio.
        let bounds = Bounds {
            x: 510.0,
            y: 50.0,
            width: 660.0,
            height: 960.0,
        }; // iPad letterbox
        let mut truth = SyntheticGroundTruth::new(
            Point {
                x: 1118.0,
                y: 1010.0,
            },
            Axes { x: 1.5, y: 1.5 },
            Some(bounds),
        );
        let mut belief = CursorBelief::new(CursorBeliefOptions {
            initial_position_variance: Some(4.0),
            bounds: Some(bounds),
            ..CursorBeliefOptions::new(Point {
                x: 1118.0,
                y: 1010.0,
            })
        });
        // 6 chunks of (+15, 0): truth stays clamped, belief should know.
        for _ in 0..6 {
            truth.emit(15.0, 0.0);
            belief.predict(Emit { dx: 15.0, dy: 0.0 }, None);
        }
        assert_eq!(truth.position.x, 1170.0); // truth clamped at right edge
        assert_eq!(belief.position.x, 1170.0); // belief clamped too
        assert!(belief.variance().x > 50.0); // belief knows it's uncertain
                                             // Now unstick: 4 chunks of (-50, -50). Truth moves; belief should move.
        for _ in 0..4 {
            truth.emit(-50.0, -50.0);
            belief.predict(
                Emit {
                    dx: -50.0,
                    dy: -50.0,
                },
                None,
            );
        }
        // Truth has moved away from right edge.
        assert!(truth.position.x < 1170.0);
        assert!(belief.position.x < 1170.0);
    }
}
