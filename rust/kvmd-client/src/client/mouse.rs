//! Mouse emission: absolute move, relative move (with belief-predict +
//! keepalive-clock side effects), click, and wheel scroll.

use super::core::PiKVMClient;
use super::error::ClientError;
use super::request::{HttpMethod, RequestArgs};
use super::types::MouseButton;
use super::wheel::{chunk_wheel_deltas, WHEEL_STEP_MAX};
use crate::emit_clock;
use std::time::Duration;

// Relative mouse deltas are limited to signed 8-bit range.
const MOUSE_DELTA_MIN: f64 = -127.0;
const MOUSE_DELTA_MAX: f64 = 127.0;

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

impl PiKVMClient {
    /// Move mouse to absolute pixel position (via REST API). Coordinates
    /// are automatically scaled from screenshot space to screen space if
    /// a scaled screenshot was previously taken. Returns whether
    /// calibration was invalidated by a resolution change.
    pub async fn mouse_move(&self, x: f64, y: f64) -> Result<bool, ClientError> {
        let (sx, sy) = self.scale_coordinates(x, y);
        let resolution = self.get_resolution(true).await?;

        let mut calibration_invalidated = false;
        if self.has_resolution_changed(resolution) {
            *self.calibration.lock().unwrap() = None;
            calibration_invalidated = true;
        }

        let normalized = self.pixel_to_normalized(sx, sy, resolution);
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!(
                "/hid/events/send_mouse_move?to_x={}&to_y={}",
                normalized.0, normalized.1
            ),
            body: None,
        })
        .await?;
        // Absolute-mode counterpart to mouse_move_relative's own
        // record_emit() call, added per
        // docs/cascade-change-detection-prefilter-design.md's v1-scope
        // gap (task_c8c4b0f2083f): the change-detection cache's
        // wholesale invalidation-on-emit trigger (crop_cache.rs) reads
        // this clock, and previously only fired for relative-mode moves
        // — an absolute-mode move never invalidated the cache, risking a
        // stale cached verdict being served after a real move landed.
        // Deliberately NOT calling `belief.predict()` here — belief
        // tracks a RELATIVE offset from a known origin; an absolute move
        // sets an exact, already-known destination, so there's no
        // relative delta to fold in, and doing so would double-count
        // against whatever already resets belief for absolute targets.
        emit_clock::record_emit();

        Ok(calibration_invalidated)
    }

    /// Move mouse relative to current position (via REST API).
    /// `delta_x`/`delta_y`: negative = left/up, positive = right/down.
    pub async fn mouse_move_relative(&self, delta_x: f64, delta_y: f64) -> Result<(), ClientError> {
        let clamped_x = clamp_f64(delta_x.round(), MOUSE_DELTA_MIN, MOUSE_DELTA_MAX);
        let clamped_y = clamp_f64(delta_y.round(), MOUSE_DELTA_MIN, MOUSE_DELTA_MAX);

        // The TS opt-in PIKVM_EMIT_LOG stack-trace capture is NOT ported:
        // Rust has no equivalent to JS's cheap `Error().stack`, and
        // capturing a real backtrace on every HID emit would be a much
        // higher-cost operation for an optional diagnostic feature.
        // Individually-flagged deviation — the {t, requested, clamped}
        // JSON logging itself is not yet wired here either, pending a
        // real caller that needs it.

        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!(
                "/hid/events/send_mouse_relative?delta_x={}&delta_y={}",
                clamped_x as i64, clamped_y as i64
            ),
            body: None,
        })
        .await?;
        // Phase 187: stamp the keepalive clock.
        emit_clock::record_emit();
        // Phase 192-B: forward-predict the cursor belief by the CLAMPED
        // emit (what was actually sent over HID).
        self.belief.lock().unwrap().predict(
            pikvm_mcp_cursor_belief::Emit {
                dx: clamped_x,
                dy: clamped_y,
            },
            None,
        );
        Ok(())
    }

    /// Click mouse button (via REST API). With `options.state` set, sends
    /// a single press-or-release event. Otherwise sends a full click:
    /// press, hold `down_ms` (default 150ms — iPadOS requires a
    /// non-zero press duration to register a tap reliably), release.
    pub async fn mouse_click(
        &self,
        button: MouseButton,
        state: Option<bool>,
        down_ms: Option<u64>,
    ) -> Result<(), ClientError> {
        let button = button.as_str();
        if let Some(state) = state {
            self.request(RequestArgs {
                method: HttpMethod::Post,
                path: format!("/hid/events/send_mouse_button?button={button}&state={state}"),
                body: None,
            })
            .await?;
            return Ok(());
        }
        let down_ms = down_ms.unwrap_or(150);
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!("/hid/events/send_mouse_button?button={button}&state=true"),
            body: None,
        })
        .await?;
        if down_ms > 0 {
            tokio::time::sleep(Duration::from_millis(down_ms)).await;
        }
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!("/hid/events/send_mouse_button?button={button}&state=false"),
            body: None,
        })
        .await?;
        Ok(())
    }

    /// Scroll mouse wheel (via REST API). Chunks large deltas into
    /// repeated ±`WHEEL_STEP_MAX` events (see `chunk_wheel_deltas`).
    pub async fn mouse_scroll(&self, delta_x: f64, delta_y: f64) -> Result<(), ClientError> {
        for ev in chunk_wheel_deltas(delta_x, delta_y, WHEEL_STEP_MAX) {
            self.request(RequestArgs {
                method: HttpMethod::Post,
                path: format!(
                    "/hid/events/send_mouse_wheel?delta_x={}&delta_y={}",
                    ev.delta_x, ev.delta_y
                ),
                body: None,
            })
            .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::client::core::{create_default_belief, PiKVMClient};
    use crate::client::request::{RequestArgs, RequestFn, ResponseBody};
    use crate::client::types::PiKVMConfig;
    use pikvm_mcp_cursor_belief::{Bounds as BeliefBounds, Point};
    use std::sync::Arc;

    fn stub_request_fn() -> RequestFn {
        Arc::new(|_args: RequestArgs| Box::pin(async { Ok(ResponseBody::Empty) }))
    }

    fn new_test_client() -> PiKVMClient {
        PiKVMClient::with_request_fn(
            PiKVMConfig::new("mock.local", "admin", "x"),
            None,
            stub_request_fn(),
        )
    }

    fn pt(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    #[tokio::test]
    async fn mouse_move_relative_forwards_the_clamped_emit_to_belief_predict() {
        let c = new_test_client();
        c.reset_belief(pt(100.0, 100.0));
        assert_eq!(c.belief.lock().unwrap().position, pt(100.0, 100.0));

        c.mouse_move_relative(20.0, 0.0).await.unwrap();

        // belief.position should have advanced by 20 * default ratio (1.3) = 26 px.
        let pos = c.belief.lock().unwrap().position;
        assert!((pos.x - 126.0).abs() < 0.1);
        assert_eq!(pos.y, 100.0);
    }

    #[tokio::test]
    async fn belief_predict_uses_clamped_values_not_raw_caller_input() {
        let c = new_test_client();
        c.reset_belief(pt(0.0, 0.0));

        // Caller asks for +500 mickeys; PiKVM clamps to +127.
        c.mouse_move_relative(500.0, 0.0).await.unwrap();

        // belief.predict must see 127, not 500: 127 * 1.3 = 165.1.
        let pos = c.belief.lock().unwrap().position;
        assert!((pos.x - 165.1).abs() < 1.0);
    }

    #[tokio::test]
    async fn multiple_emits_accumulate_in_belief_position() {
        let c = new_test_client();
        c.reset_belief(pt(0.0, 0.0));
        c.mouse_move_relative(10.0, 0.0).await.unwrap();
        c.mouse_move_relative(10.0, 0.0).await.unwrap();
        c.mouse_move_relative(10.0, 0.0).await.unwrap();
        let pos = c.belief.lock().unwrap().position;
        assert!((pos.x - 39.0).abs() < 0.1);
    }

    #[tokio::test]
    async fn set_belief_bounds_enables_clip_and_inflate_behaviour() {
        let c = new_test_client();
        c.set_belief_bounds(Some(BeliefBounds {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 800.0,
        }));
        c.reset_belief(pt(990.0, 400.0));

        let x_var_before = c.belief.lock().unwrap().variance().x;
        c.mouse_move_relative(50.0, 0.0).await.unwrap();

        let belief = c.belief.lock().unwrap();
        assert_eq!(belief.position.x, 1000.0);
        assert!(belief.variance().x > x_var_before);
    }

    #[tokio::test]
    async fn observe_cursor_pushes_a_measurement_into_the_belief() {
        let c = new_test_client();
        c.reset_belief(pt(0.0, 0.0));
        c.mouse_move_relative(10.0, 0.0).await.unwrap(); // belief now ≈ (13, 0)

        c.observe_cursor(pt(13.0, 0.0), 0.95, None);
        let belief = c.belief.lock().unwrap();
        assert!((belief.position.x - 13.0).abs() < 0.5);
        assert!(belief.variance().x < 2.0);
    }

    #[test]
    fn belief_is_initialised_wide_so_a_fresh_client_does_not_pretend_to_know_position() {
        let c = new_test_client();
        let region = c.belief.lock().unwrap().expected_region(Some(0.95));
        assert!(region.rx > 150.0);
        assert!(region.ry > 150.0);
    }

    #[tokio::test]
    async fn phase_315_default_bounds_prevent_belief_position_drift_to_extreme_negatives() {
        let c = new_test_client();
        c.reset_belief(pt(100.0, 100.0));
        for _ in 0..12 {
            c.mouse_move_relative(-127.0, 0.0).await.unwrap();
        }
        let pos = c.belief.lock().unwrap().position;
        assert!(pos.x >= 0.0);
        assert!(pos.y >= 0.0);
    }

    #[tokio::test]
    async fn emits_still_advance_the_keepalive_clock() {
        let c = new_test_client();
        c.reset_belief(pt(0.0, 0.0));
        c.mouse_move_relative(15.0, 0.0).await.unwrap();
        assert!(c.belief.lock().unwrap().position.x > 0.0);
    }

    #[tokio::test]
    async fn c1_p2_an_injected_belief_is_used_as_is() {
        let injected = create_default_belief();
        let c = PiKVMClient::with_request_fn(
            PiKVMConfig::new("mock.local", "admin", "x"),
            Some(injected),
            stub_request_fn(),
        );
        c.reset_belief(pt(100.0, 100.0));
        c.mouse_move_relative(20.0, 0.0).await.unwrap();
        let pos = c.belief.lock().unwrap().position;
        assert!((pos.x - 126.0).abs() < 0.1);
    }

    #[test]
    fn c1_p2_omitting_the_belief_still_yields_an_equivalent_default() {
        let a = new_test_client();
        let b = new_test_client();
        let ra = a.belief.lock().unwrap().expected_region(Some(0.95));
        let rb = b.belief.lock().unwrap().expected_region(Some(0.95));
        assert!((ra.rx - rb.rx).abs() < 1e-5);
    }

    mod stationary_cluster_rejection_wiring {
        use super::*;

        #[test]
        fn would_reject_as_stationary_returns_false_before_any_observation() {
            let c = new_test_client();
            c.reset_belief(pt(0.0, 0.0));
            assert!(!c.would_reject_as_stationary(pt(100.0, 100.0), None));
        }

        #[tokio::test]
        async fn would_reject_as_stationary_delegates_to_belief() {
            let c = new_test_client();
            c.reset_belief(pt(0.0, 0.0));
            c.observe_cursor(pt(970.0, 771.0), 0.9, None);
            c.mouse_move_relative(50.0, 0.0).await.unwrap();
            assert!(c.would_reject_as_stationary(pt(970.0, 771.0), None));
            assert!(!c.would_reject_as_stationary(pt(1100.0, 770.0), None));
        }

        #[tokio::test]
        async fn observe_cursor_with_reject_stationary_returns_false_on_lock_in() {
            let c = new_test_client();
            c.reset_belief(pt(0.0, 0.0));
            c.observe_cursor(pt(970.0, 771.0), 0.9, None);
            c.mouse_move_relative(50.0, 0.0).await.unwrap();
            let x_after_predict = c.belief.lock().unwrap().position.x;
            let accepted = c.observe_cursor(
                pt(970.0, 771.0),
                0.9,
                Some(pikvm_mcp_cursor_belief::ObserveOptions {
                    reject_stationary: true,
                    ..Default::default()
                }),
            );
            assert!(!accepted);
            assert_eq!(c.belief.lock().unwrap().position.x, x_after_predict);
        }

        #[tokio::test]
        async fn observe_cursor_with_reject_stationary_returns_true_on_a_clearly_moved_measurement()
        {
            let c = new_test_client();
            c.reset_belief(pt(0.0, 0.0));
            c.observe_cursor(pt(970.0, 771.0), 0.9, None);
            c.mouse_move_relative(50.0, 0.0).await.unwrap();
            let accepted = c.observe_cursor(
                pt(1100.0, 770.0),
                0.9,
                Some(pikvm_mcp_cursor_belief::ObserveOptions {
                    reject_stationary: true,
                    ..Default::default()
                }),
            );
            assert!(accepted);
        }
    }
}
