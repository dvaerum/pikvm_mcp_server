//! Coordinate calibration: pixel↔normalized mapping, the calibration
//! state machine, and raw (uncalibrated) absolute moves used during
//! auto-calibration.

use super::core::PiKVMClient;
use super::error::ClientError;
use super::request::{HttpMethod, RequestArgs};
use super::types::{CalibrationResult, CalibrationState, ScreenResolution};

// PiKVM uses signed 16-bit integers for absolute mouse coordinates.
const MOUSE_COORD_MIN: i32 = -32768;
const MOUSE_COORD_MAX: i32 = 32767;

/// Linearly remap a value from one range to another.
fn remap(value: f64, from_min: f64, from_max: f64, to_min: f64, to_max: f64) -> i32 {
    (to_min + (value - from_min) * (to_max - to_min) / (from_max - from_min)).round() as i32
}

fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
    value.max(min).min(max)
}

impl PiKVMClient {
    /// Convert pixel coordinates to PiKVM's normalized coordinate system
    /// (range -32768..32767). Calibration factors compensate for
    /// resolution-dependent scaling issues; without calibration, factors
    /// default to 1.0.
    pub(super) fn pixel_to_normalized(
        &self,
        pixel_x: f64,
        pixel_y: f64,
        resolution: ScreenResolution,
    ) -> (i32, i32) {
        let base_x = remap(
            pixel_x,
            0.0,
            (resolution.width - 1) as f64,
            MOUSE_COORD_MIN as f64,
            MOUSE_COORD_MAX as f64,
        );
        let base_y = remap(
            pixel_y,
            0.0,
            (resolution.height - 1) as f64,
            MOUSE_COORD_MIN as f64,
            MOUSE_COORD_MAX as f64,
        );

        let calibration = *self.calibration.lock().unwrap();
        let factor_x = calibration.map(|c| c.factor_x).unwrap_or(1.0);
        let factor_y = calibration.map(|c| c.factor_y).unwrap_or(1.0);

        let corrected_x = ((base_x as f64 + 32768.0) * factor_x).round() as i32 - 32768;
        let corrected_y = ((base_y as f64 + 32768.0) * factor_y).round() as i32 - 32768;

        (
            clamp_i32(corrected_x, MOUSE_COORD_MIN, MOUSE_COORD_MAX),
            clamp_i32(corrected_y, MOUSE_COORD_MIN, MOUSE_COORD_MAX),
        )
    }

    /// Perform calibration by moving the cursor to the center of the
    /// screen. Returns information needed for the agent to calculate
    /// calibration factors.
    pub async fn calibrate(&self) -> Result<CalibrationResult, ClientError> {
        let resolution = self.get_resolution(true).await?;
        let center_x = (resolution.width as f64 / 2.0).round() as i64;
        let center_y = (resolution.height as f64 / 2.0).round() as i64;

        let saved_calibration = self.calibration.lock().unwrap().take();
        let normalized = self.pixel_to_normalized(center_x as f64, center_y as f64, resolution);
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!(
                "/hid/events/send_mouse_move?to_x={}&to_y={}",
                normalized.0, normalized.1
            ),
            body: None,
        })
        .await?;
        *self.calibration.lock().unwrap() = saved_calibration;

        Ok(CalibrationResult {
            expected_position: (center_x, center_y),
            requested_normalized: normalized,
            resolution,
            message: format!(
                "Cursor moved to expected center position ({center_x}, {center_y}). \
                 Please take a screenshot and visually verify the actual cursor position. \
                 Then call pikvm_set_calibration with the calculated factors: \
                 factorX = {center_x} / actual_x, factorY = {center_y} / actual_y"
            ),
        })
    }

    /// Sanity check: factors should be reasonable (0.5 to 2.0).
    pub fn set_calibration_factors(&self, factor_x: f64, factor_y: f64) -> Result<(), ClientError> {
        if !(0.5..=2.0).contains(&factor_x) || !(0.5..=2.0).contains(&factor_y) {
            return Err(ClientError::Other(format!(
                "Calibration factors out of reasonable range (0.5-2.0): factorX={factor_x}, factorY={factor_y}"
            )));
        }
        let resolution = self
            .cached_resolution
            .lock()
            .unwrap()
            .unwrap_or(ScreenResolution {
                width: 0,
                height: 0,
            });
        *self.calibration.lock().unwrap() = Some(CalibrationState {
            factor_x,
            factor_y,
            resolution,
        });
        Ok(())
    }

    pub fn get_calibration(&self) -> Option<CalibrationState> {
        *self.calibration.lock().unwrap()
    }

    pub fn clear_calibration(&self) {
        *self.calibration.lock().unwrap() = None;
    }

    /// Move mouse to absolute pixel position WITHOUT calibration or
    /// screenshot scaling. Used during auto-calibration to send known
    /// uncalibrated positions.
    pub async fn mouse_move_raw(&self, x: f64, y: f64) -> Result<(), ClientError> {
        let resolution = self.get_resolution(false).await?;
        let saved_calibration = self.calibration.lock().unwrap().take();
        let normalized = self.pixel_to_normalized(x, y, resolution);
        *self.calibration.lock().unwrap() = saved_calibration;
        self.request(RequestArgs {
            method: HttpMethod::Post,
            path: format!(
                "/hid/events/send_mouse_move?to_x={}&to_y={}",
                normalized.0, normalized.1
            ),
            body: None,
        })
        .await?;
        Ok(())
    }

    pub(super) fn has_resolution_changed(&self, current: ScreenResolution) -> bool {
        match *self.calibration.lock().unwrap() {
            Some(c) => c.resolution != current,
            None => false,
        }
    }

    /// Scale coordinates from screenshot space to actual screen space. If
    /// no screenshot has been taken, coordinates pass through unchanged.
    pub(super) fn scale_coordinates(&self, x: f64, y: f64) -> (f64, f64) {
        match &*self.screenshot_scale.lock().unwrap() {
            Some(s) => ((x * s.scale_x).round(), (y * s.scale_y).round()),
            None => (x, y),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::client::core::PiKVMClient;
    use crate::client::request::{RequestArgs, RequestFn, ResponseBody};
    use crate::client::types::{PiKVMConfig, ScreenResolution};
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

    #[test]
    fn starts_uncalibrated() {
        let client = new_test_client();
        assert_eq!(client.get_calibration(), None);
    }

    #[test]
    fn set_calibration_factors_records_factors_for_retrieval() {
        let client = new_test_client();
        client.set_calibration_factors(1.1, 1.2).unwrap();
        let cal = client.get_calibration().unwrap();
        assert_eq!(cal.factor_x, 1.1);
        assert_eq!(cal.factor_y, 1.2);
    }

    #[test]
    fn clear_calibration_returns_to_uncalibrated() {
        let client = new_test_client();
        client.set_calibration_factors(1.0, 1.0).unwrap();
        client.clear_calibration();
        assert_eq!(client.get_calibration(), None);
    }

    #[test]
    fn rejects_factor_x_below_the_lower_bound() {
        let client = new_test_client();
        assert!(client.set_calibration_factors(0.4, 1.0).is_err());
    }

    #[test]
    fn rejects_factor_x_above_the_upper_bound() {
        let client = new_test_client();
        assert!(client.set_calibration_factors(2.1, 1.0).is_err());
    }

    #[test]
    fn rejects_factor_y_below_the_lower_bound() {
        let client = new_test_client();
        assert!(client.set_calibration_factors(1.0, 0.4).is_err());
    }

    #[test]
    fn rejects_factor_y_above_the_upper_bound() {
        let client = new_test_client();
        assert!(client.set_calibration_factors(1.0, 2.1).is_err());
    }

    #[test]
    fn accepts_the_lower_boundary_value_inclusive() {
        let client = new_test_client();
        client.set_calibration_factors(0.5, 0.5).unwrap();
        assert_eq!(client.get_calibration().unwrap().factor_x, 0.5);
    }

    #[test]
    fn accepts_the_upper_boundary_value_inclusive() {
        let client = new_test_client();
        client.set_calibration_factors(2.0, 2.0).unwrap();
        assert_eq!(client.get_calibration().unwrap().factor_y, 2.0);
    }

    #[test]
    fn error_message_names_the_offending_factor_values() {
        let client = new_test_client();
        let err = client.set_calibration_factors(3.0, 0.1).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains('3') || msg.contains("0.1"));
    }

    #[test]
    fn rejected_calibration_leaves_prior_state_untouched() {
        let client = new_test_client();
        client.set_calibration_factors(1.1, 1.1).unwrap();
        assert!(client.set_calibration_factors(99.0, 99.0).is_err());
        let cal = client.get_calibration().unwrap();
        assert_eq!(cal.factor_x, 1.1);
        assert_eq!(cal.factor_y, 1.1);
    }

    #[test]
    fn snapshots_a_resolution_placeholder_when_none_has_been_cached_yet() {
        let client = new_test_client();
        client.set_calibration_factors(1.0, 1.0).unwrap();
        let cal = client.get_calibration().unwrap();
        assert_eq!(
            cal.resolution,
            ScreenResolution {
                width: 0,
                height: 0
            }
        );
    }

    #[test]
    fn close_is_safe_to_call_idempotent_no_op() {
        let client = new_test_client();
        client.close();
        client.close();
    }
}
