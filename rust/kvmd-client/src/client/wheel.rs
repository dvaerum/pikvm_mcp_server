//! Wheel-scroll chunking: the USB-HID wheel is a signed byte and kvmd's
//! send_mouse_wheel silently wraps large deltas, so a large scroll is
//! split into repeated bounded events. See `chunk_wheel_deltas`'s doc.

/// Max per-event wheel magnitude. The USB-HID wheel is a SIGNED BYTE, and
/// kvmd's send_mouse_wheel silently wraps a large value (a single
/// delta_y=500 wrapped to a ~no-op and did NOT scroll on-device). The
/// validated way to scroll a large amount is repeated MODERATE events
/// (25× delta_y=20 scrolled correctly). Cap each emitted event at ±20.
pub const WHEEL_STEP_MAX: i32 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WheelDelta {
    pub delta_x: i32,
    pub delta_y: i32,
}

/// Split a (deltaX, deltaY) scroll into a sequence of wheel events, each
/// with per-axis magnitude ≤ `step`, sign preserved, summing back to the
/// rounded input. Pure so the chunking is unit-tested without a live
/// PiKVM. A small scroll (|delta| ≤ step on both axes) yields a single
/// unchanged event; a (0,0) scroll yields no events.
pub fn chunk_wheel_deltas(delta_x: f64, delta_y: f64, step: i32) -> Vec<WheelDelta> {
    let clamp_mag = |v: i32| -> i32 { v.signum() * v.abs().min(step) };
    let mut rx = delta_x.round() as i32;
    let mut ry = delta_y.round() as i32;
    let mut events = Vec::new();
    while rx != 0 || ry != 0 {
        let ex = clamp_mag(rx);
        let ey = clamp_mag(ry);
        events.push(WheelDelta {
            delta_x: ex,
            delta_y: ey,
        });
        rx -= ex;
        ry -= ey;
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sum(evs: &[WheelDelta]) -> WheelDelta {
        evs.iter().fold(
            WheelDelta {
                delta_x: 0,
                delta_y: 0,
            },
            |a, e| WheelDelta {
                delta_x: a.delta_x + e.delta_x,
                delta_y: a.delta_y + e.delta_y,
            },
        )
    }

    #[test]
    fn leaves_a_small_scroll_as_a_single_unchanged_event() {
        assert_eq!(
            chunk_wheel_deltas(0.0, 15.0, WHEEL_STEP_MAX),
            vec![WheelDelta {
                delta_x: 0,
                delta_y: 15
            }]
        );
        assert_eq!(
            chunk_wheel_deltas(0.0, WHEEL_STEP_MAX as f64, WHEEL_STEP_MAX),
            vec![WheelDelta {
                delta_x: 0,
                delta_y: WHEEL_STEP_MAX
            }]
        );
    }

    #[test]
    fn splits_the_field_report_failure_case_into_step_events_that_sum_back() {
        let evs = chunk_wheel_deltas(0.0, 500.0, WHEEL_STEP_MAX);
        assert_eq!(evs.len(), 25); // ceil(500/20)
        assert!(evs.iter().all(|e| e.delta_y.abs() <= WHEEL_STEP_MAX));
        assert_eq!(
            sum(&evs),
            WheelDelta {
                delta_x: 0,
                delta_y: 500
            }
        );
    }

    #[test]
    fn preserves_sign_for_negative_scroll_up_deltas() {
        let evs = chunk_wheel_deltas(0.0, -50.0, WHEEL_STEP_MAX);
        assert!(evs.iter().all(|e| e.delta_y <= 0));
        assert_eq!(
            sum(&evs),
            WheelDelta {
                delta_x: 0,
                delta_y: -50
            }
        );
        assert_eq!(
            evs,
            vec![
                WheelDelta {
                    delta_x: 0,
                    delta_y: -20
                },
                WheelDelta {
                    delta_x: 0,
                    delta_y: -20
                },
                WheelDelta {
                    delta_x: 0,
                    delta_y: -10
                },
            ]
        );
    }

    #[test]
    fn handles_a_non_multiple_with_a_remainder_tail() {
        let evs = chunk_wheel_deltas(0.0, 50.0, WHEEL_STEP_MAX);
        assert_eq!(
            evs,
            vec![
                WheelDelta {
                    delta_x: 0,
                    delta_y: 20
                },
                WheelDelta {
                    delta_x: 0,
                    delta_y: 20
                },
                WheelDelta {
                    delta_x: 0,
                    delta_y: 10
                },
            ]
        );
    }

    #[test]
    fn chunks_both_axes_together_and_stops_when_both_are_drained() {
        let evs = chunk_wheel_deltas(30.0, -50.0, WHEEL_STEP_MAX);
        assert_eq!(
            sum(&evs),
            WheelDelta {
                delta_x: 30,
                delta_y: -50
            }
        );
        assert_eq!(evs.len(), 3); // max(ceil(30/20), ceil(50/20))
        assert!(evs
            .iter()
            .all(|e| e.delta_x.abs() <= WHEEL_STEP_MAX && e.delta_y.abs() <= WHEEL_STEP_MAX));
        assert_eq!(
            evs[2],
            WheelDelta {
                delta_x: 0,
                delta_y: -10
            }
        );
    }

    #[test]
    fn emits_no_events_for_a_zero_scroll() {
        assert_eq!(chunk_wheel_deltas(0.0, 0.0, WHEEL_STEP_MAX), vec![]);
    }

    #[test]
    fn rounds_fractional_deltas_before_chunking() {
        assert_eq!(
            chunk_wheel_deltas(0.0, 12.7, WHEEL_STEP_MAX),
            vec![WheelDelta {
                delta_x: 0,
                delta_y: 13
            }]
        );
    }

    #[test]
    fn honours_a_custom_step() {
        let evs = chunk_wheel_deltas(0.0, 30.0, 10);
        assert_eq!(
            evs,
            vec![
                WheelDelta {
                    delta_x: 0,
                    delta_y: 10
                },
                WheelDelta {
                    delta_x: 0,
                    delta_y: 10
                },
                WheelDelta {
                    delta_x: 0,
                    delta_y: 10
                },
            ]
        );
    }
}
