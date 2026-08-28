//! HID failure-mode discriminator. Splits the single "HID broken" bucket
//! into operationally DISTINCT states so the operator/agent picks the RIGHT
//! fix instead of blindly re-running usb_reconnect.
//!
//! Faithful port of `src/pikvm/hid-diagnosis.ts`.
//!
//!   - HID DOWN — the USB gadget input path is dead. A CONFIDENT, directive
//!     DOWN ("run pikvm_usb_reconnect") is emitted ONLY from UDC KERNEL STATE
//!     (the loopback endpoint or the SSH reader). The kvmd HID flags are NOT
//!     trusted for a confident down verdict: live-observed 2026-07-30 that
//!     BOTH flags read offline on a demonstrably-working HID (UDC configured,
//!     clicks landing) — so the flags lie in BOTH directions and no
//!     flags-derived DOWN is trustworthy.
//!   - HID-down SUSPECTED (flags only) — when no UDC kernel reader is
//!     available and the flags fall to their DOWN signature (BOTH offline),
//!     the verdict is a NON-DIRECTIVE hedge: "confirm behaviorally before
//!     reconnecting", never a bare "run pikvm_usb_reconnect". This is the
//!     field reality — production has no UDC reader wired.
//!   - HID UP but cursor NOT LOCALIZABLE — the gadget IS attached (input
//!     reaches the target) yet the pointer can't be found on screen (faded /
//!     off-screen / dim frame). usb_reconnect does NOTHING for this; the fix
//!     is to wake the cursor (a mouse nudge) or raise brightness.
//!
//! On the flags fallback, HID is treated UP if EITHER mouse or keyboard is
//! online (NOT keyboard alone, NOT mouse alone); DOWN requires BOTH offline,
//! the genuinely-dead signature. UDC kernel state, when available, is
//! AUTHORITATIVE and overrides the flags entirely.
//!
//! Kept out of hid_recovery.rs on purpose: this classifies a state, it does
//! not drive the recovery ladder.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::hid_recovery::UdcState;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CursorPoint {
    pub x: f64,
    pub y: f64,
}

/// Injectable pointer localization — normally the SAME V8 detector the
/// mover/click use (module 3), so "localizable" here means exactly what it
/// means at click time. NOT wired to a real default yet: module 3
/// (`findCursorByV8FullFrame`) hasn't landed. Callers MUST inject one;
/// there is no `default_cursor_locator` in this crate until then (a
/// deliberate, flagged gap — see the module 5 increment-1 commit).
pub type CursorLocator =
    Arc<dyn Fn(Vec<u8>) -> BoxFuture<'static, Option<CursorPoint>> + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub enum HidDiagnosis {
    Healthy {
        cursor: CursorPoint,
    },
    /// CONFIDENT, directive — only from UDC kernel state.
    HidDown,
    /// flags-only, NON-DIRECTIVE hedge.
    HidDownSuspected,
    UpNoCursor,
    Unknown,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ClassifyHidInput {
    /// HID up/down: UDC.online when a kernel reader is wired, else the kvmd
    /// flags (mouse OR keyboard online), else `None` when neither can be
    /// read (→ Unknown, never a false verdict).
    pub hid_up: Option<bool>,
    /// Result of localizing the pointer in a fresh frame, or `None`.
    pub cursor: Option<CursorPoint>,
    /// Whether `hid_up` derives from UDC KERNEL STATE (authoritative) rather
    /// than the kvmd flags. A down verdict is CONFIDENT/directive only when
    /// confirmed; a flags-derived down is a NON-DIRECTIVE hedge, because the
    /// flags are known to misreport DOWN on a working HID.
    pub udc_confirmed: bool,
}

/// Pure classifier.
pub fn classify_hid(input: ClassifyHidInput) -> HidDiagnosis {
    match input.hid_up {
        Some(false) => {
            if input.udc_confirmed {
                HidDiagnosis::HidDown
            } else {
                HidDiagnosis::HidDownSuspected
            }
        }
        Some(true) => match input.cursor {
            Some(cursor) => HidDiagnosis::Healthy { cursor },
            None => HidDiagnosis::UpNoCursor,
        },
        None => HidDiagnosis::Unknown,
    }
}

/// One-line verdict + the corrective action, for the health/recover reports.
pub fn describe_hid_diagnosis(d: &HidDiagnosis) -> String {
    match d {
        HidDiagnosis::Healthy { cursor } => format!(
            "HID UP and cursor localizable at ({},{}) — input path AND pointer both good.",
            cursor.x as i64, cursor.y as i64
        ),
        // CONFIDENT — backed by UDC kernel state. Safe to issue the reconnect directive.
        HidDiagnosis::HidDown => (
            "HID DOWN (UDC kernel state) — the USB gadget input path is dead. \
             Fix: run pikvm_usb_reconnect (add the reboot rung via pikvm_hid_recover if that doesn't take)."
        ).to_string(),
        // NON-DIRECTIVE — flags only, no kernel truth.
        HidDiagnosis::HidDownSuspected => (
            "⚠ Possible HID-down (UNCONFIRMED) — both kvmd HID flags read offline, but there is NO UDC kernel \
             ground truth available here and these flags are known to misreport (seen offline on a working HID). \
             Do NOT reconnect yet: confirm behaviorally first — does a click land? does the cursor localize? — \
             and only then run pikvm_usb_reconnect if input is truly dead. Wire PIKVM_HID_RECOVERY_URL (or the \
             SSH UDC reader) for an authoritative verdict."
        ).to_string(),
        HidDiagnosis::UpNoCursor => (
            "⚠ HID UP but cursor NOT LOCALIZABLE — the gadget IS attached (a HID flag online / UDC configured, \
             input reaches the target) but the pointer can't be found on screen (faded / off-screen / dim frame). \
             pikvm_usb_reconnect will NOT help — this is not a HID-down state. Wake the cursor with a nudge \
             (pikvm_mouse_move) or raise brightness, then re-check."
        ).to_string(),
        HidDiagnosis::Unknown => (
            "HID state UNKNOWN — no UDC endpoint and the kvmd HID flags could not be read to tell HID up from down. \
             Set PIKVM_HID_RECOVERY_URL (or the SSH transport) for the ground-truth UDC signal."
        ).to_string(),
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct HidProfile {
    pub mouse_online: bool,
    pub keyboard_online: bool,
    pub mouse_absolute: bool,
}

/// The subset of the kvmd client the diagnosis drives — structural so tests
/// inject a stub.
pub struct HidDiagnosisClient {
    screenshot_fn: Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<Vec<u8>>> + Send + Sync>,
    get_hid_profile_fn:
        Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<HidProfile>> + Send + Sync>,
}

impl HidDiagnosisClient {
    pub fn new(
        screenshot_fn: impl Fn() -> BoxFuture<'static, anyhow::Result<Vec<u8>>> + Send + Sync + 'static,
        get_hid_profile_fn: impl Fn() -> BoxFuture<'static, anyhow::Result<HidProfile>>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self {
            screenshot_fn: Arc::new(screenshot_fn),
            get_hid_profile_fn: Arc::new(get_hid_profile_fn),
        }
    }
    pub async fn screenshot(&self) -> anyhow::Result<Vec<u8>> {
        (self.screenshot_fn)().await
    }
    pub async fn get_hid_profile(&self) -> anyhow::Result<HidProfile> {
        (self.get_hid_profile_fn)().await
    }
}

/// Orchestrated diagnosis for the recover handlers: reads the UDC ground
/// truth (falling back to the kvmd HID flags when the endpoint isn't
/// wired), localizes the cursor in a fresh frame, and classifies. Never
/// panics — a failed keyboard probe or screenshot degrades to
/// Unknown/no-cursor rather than propagating an error to the caller's
/// failure path.
pub async fn diagnose_hid_from_client(
    client: &HidDiagnosisClient,
    udc_reader: &(dyn Fn() -> BoxFuture<'static, Option<UdcState>> + Send + Sync),
    locate: &CursorLocator,
) -> HidDiagnosis {
    // HID up/down: UDC KERNEL STATE is authoritative when a reader yields
    // it; only then is a down verdict confident/directive. Else fall back to
    // the kvmd flags — mouse OR keyboard online (NOT keyboard alone: a
    // healthy box was live-observed 2026-07-30 reporting keyboard=offline
    // while the mouse clicked 4/4; genuinely-dead HID showed BOTH offline).
    // A flags-derived down is only SUSPECTED, never a reconnect directive.
    let mut hid_up: Option<bool> = None;
    let mut udc_confirmed = false;
    if let Some(udc) = udc_reader().await {
        hid_up = Some(udc.online);
        udc_confirmed = true;
    } else if let Ok(hid) = client.get_hid_profile().await {
        hid_up = Some(hid.mouse_online || hid.keyboard_online);
    }

    // Only bother localizing the cursor when HID might be up — a down input
    // path is DOWN no matter what the pointer looks like, and we skip an
    // ORT inference.
    let mut cursor: Option<CursorPoint> = None;
    if hid_up != Some(false) {
        if let Ok(buf) = client.screenshot().await {
            cursor = locate(buf).await;
        }
    }

    classify_hid(ClassifyHidInput {
        hid_up,
        cursor,
        udc_confirmed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cursor(x: f64, y: f64) -> CursorPoint {
        CursorPoint { x, y }
    }

    #[test]
    fn classify_hid_down_confirmed_by_udc() {
        let d = classify_hid(ClassifyHidInput {
            hid_up: Some(false),
            cursor: None,
            udc_confirmed: true,
        });
        assert_eq!(d, HidDiagnosis::HidDown);
    }

    #[test]
    fn classify_hid_down_suspected_when_not_udc_confirmed() {
        let d = classify_hid(ClassifyHidInput {
            hid_up: Some(false),
            cursor: None,
            udc_confirmed: false,
        });
        assert_eq!(d, HidDiagnosis::HidDownSuspected);
    }

    #[test]
    fn classify_healthy_when_up_and_cursor_found() {
        let c = cursor(100.0, 200.0);
        let d = classify_hid(ClassifyHidInput {
            hid_up: Some(true),
            cursor: Some(c),
            udc_confirmed: false,
        });
        assert_eq!(d, HidDiagnosis::Healthy { cursor: c });
    }

    #[test]
    fn classify_up_no_cursor_when_up_but_no_cursor_found() {
        let d = classify_hid(ClassifyHidInput {
            hid_up: Some(true),
            cursor: None,
            udc_confirmed: false,
        });
        assert_eq!(d, HidDiagnosis::UpNoCursor);
    }

    #[test]
    fn classify_unknown_when_hid_up_cannot_be_determined() {
        let d = classify_hid(ClassifyHidInput {
            hid_up: None,
            cursor: Some(cursor(0.0, 0.0)),
            udc_confirmed: false,
        });
        assert_eq!(d, HidDiagnosis::Unknown);
    }

    #[test]
    fn describe_healthy_includes_coordinates() {
        let msg = describe_hid_diagnosis(&HidDiagnosis::Healthy {
            cursor: cursor(42.0, 7.0),
        });
        assert!(msg.contains("(42,7)"));
        assert!(msg.contains("both good"));
    }

    #[test]
    fn describe_hid_down_is_directive() {
        let msg = describe_hid_diagnosis(&HidDiagnosis::HidDown);
        assert!(msg.contains("Fix: run pikvm_usb_reconnect"));
    }

    #[test]
    fn describe_hid_down_suspected_is_non_directive() {
        let msg = describe_hid_diagnosis(&HidDiagnosis::HidDownSuspected);
        assert!(msg.contains("Do NOT reconnect yet"));
    }

    #[test]
    fn describe_up_no_cursor_says_reconnect_wont_help() {
        let msg = describe_hid_diagnosis(&HidDiagnosis::UpNoCursor);
        assert!(msg.contains("will NOT help"));
    }

    #[test]
    fn describe_unknown_names_the_env_var() {
        let msg = describe_hid_diagnosis(&HidDiagnosis::Unknown);
        assert!(msg.contains("PIKVM_HID_RECOVERY_URL"));
    }

    fn locator_returning(point: Option<CursorPoint>) -> CursorLocator {
        Arc::new(move |_buf: Vec<u8>| {
            let point = point;
            Box::pin(async move { point })
        })
    }

    fn no_udc_reader() -> impl Fn() -> BoxFuture<'static, Option<UdcState>> + Send + Sync {
        || Box::pin(async { None })
    }

    fn udc_reader_returning(
        state: UdcState,
    ) -> impl Fn() -> BoxFuture<'static, Option<UdcState>> + Send + Sync {
        move || {
            let state = state.clone();
            Box::pin(async move { Some(state) })
        }
    }

    #[tokio::test]
    async fn diagnose_prefers_udc_over_flags_when_both_available() {
        // Flags say up (would be Healthy/UpNoCursor), UDC says down — UDC wins,
        // confidently (HidDown, not HidDownSuspected).
        let client = HidDiagnosisClient::new(
            || Box::pin(async { Ok(vec![1u8]) }),
            || {
                Box::pin(async {
                    Ok(HidProfile {
                        mouse_online: true,
                        keyboard_online: true,
                        mouse_absolute: true,
                    })
                })
            },
        );
        let udc_reader = udc_reader_returning(UdcState {
            udc: Some("u".into()),
            state: "not attached".into(),
            online: false,
        });
        let locate = locator_returning(None);
        let d = diagnose_hid_from_client(&client, &udc_reader, &locate).await;
        assert_eq!(d, HidDiagnosis::HidDown);
    }

    #[tokio::test]
    async fn diagnose_falls_back_to_flags_when_no_udc_reader() {
        let client = HidDiagnosisClient::new(
            || Box::pin(async { Ok(vec![1u8]) }),
            || {
                Box::pin(async {
                    Ok(HidProfile {
                        mouse_online: false,
                        keyboard_online: false,
                        mouse_absolute: false,
                    })
                })
            },
        );
        let udc_reader = no_udc_reader();
        let locate = locator_returning(None);
        let d = diagnose_hid_from_client(&client, &udc_reader, &locate).await;
        assert_eq!(d, HidDiagnosis::HidDownSuspected);
    }

    #[tokio::test]
    async fn diagnose_flags_up_with_either_mouse_or_keyboard_online() {
        // keyboard offline, mouse online -> treated UP (not both-required for UP).
        let client = HidDiagnosisClient::new(
            || Box::pin(async { Ok(vec![1u8]) }),
            || {
                Box::pin(async {
                    Ok(HidProfile {
                        mouse_online: true,
                        keyboard_online: false,
                        mouse_absolute: false,
                    })
                })
            },
        );
        let udc_reader = no_udc_reader();
        let locate = locator_returning(Some(cursor(5.0, 5.0)));
        let d = diagnose_hid_from_client(&client, &udc_reader, &locate).await;
        assert_eq!(
            d,
            HidDiagnosis::Healthy {
                cursor: cursor(5.0, 5.0)
            }
        );
    }

    #[tokio::test]
    async fn diagnose_skips_localization_when_hid_confidently_down() {
        // The locator would panic if called (via a poison marker) -- confirm the
        // orchestration actually skips the ORT inference when hid_up==false.
        let client = HidDiagnosisClient::new(
            || Box::pin(async { Ok(vec![1u8]) }),
            || {
                Box::pin(async {
                    Ok(HidProfile {
                        mouse_online: false,
                        keyboard_online: false,
                        mouse_absolute: false,
                    })
                })
            },
        );
        let udc_reader = udc_reader_returning(UdcState {
            udc: None,
            state: "absent".into(),
            online: false,
        });
        let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let called_clone = called.clone();
        let locate: CursorLocator = Arc::new(move |_buf| {
            called_clone.store(true, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async { None })
        });
        let d = diagnose_hid_from_client(&client, &udc_reader, &locate).await;
        assert_eq!(d, HidDiagnosis::HidDown);
        assert!(
            !called.load(std::sync::atomic::Ordering::SeqCst),
            "locator should not be called when HID is confidently down"
        );
    }

    #[tokio::test]
    async fn diagnose_degrades_to_unknown_on_client_errors_not_panic() {
        let client = HidDiagnosisClient::new(
            || Box::pin(async { anyhow::bail!("screenshot failed") }),
            || Box::pin(async { anyhow::bail!("hid profile fetch failed") }),
        );
        let udc_reader = no_udc_reader();
        let locate = locator_returning(None);
        let d = diagnose_hid_from_client(&client, &udc_reader, &locate).await;
        assert_eq!(d, HidDiagnosis::Unknown);
    }
}
