//! M8 — per-call before/during/after frame capture for the mouse tools
//! (pikvm_mouse_click_at, pikvm_mouse_move, pikvm_mouse_move_to).
//!
//! Faithful port of `src/pikvm/capture.ts`.
//!
//! This is the first-class, typed generalization of the env-gated
//! `PIKVM_PREDOWN_DIR` proof-shot: a caller can ask a single move/click to
//! write a baseline ("before"), a cursor-guaranteed-rendered frame at the
//! operation's business end ("during"), and a post-op frame ("after"), then
//! get the saved paths back in the tool result. Capture is ADVISORY — it
//! never alters the click/move outcome, only adds latency for the phases
//! requested.
//!
//! The "during" grab MUST go through the cursor-alive path (net-zero ±1px
//! nudge): a plain screenshot races the ~1-2s iPad cursor fade and comes
//! back cursorless. `cursor_alive_grab` is the ONE shared helper the
//! predown proof-shot and `capture: ["during"]` both use.

use crate::snapshot::{save_snapshot, SnapshotRegion};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
type ScreenshotFn = Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<Vec<u8>>> + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapturePhase {
    Before,
    During,
    After,
}

impl CapturePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            CapturePhase::Before => "before",
            CapturePhase::During => "during",
            CapturePhase::After => "after",
        }
    }
}

/// A validated capture request. `None` config = capture OFF.
#[derive(Clone, Debug)]
pub struct CaptureConfig {
    /// Which phases to write. De-duplicated, order-preserving. Non-empty.
    pub phases: Vec<CapturePhase>,
    /// Path prefix; each phase writes `${prefix}-${phase}.jpg` (parent dirs
    /// created by `save_snapshot`).
    pub prefix: String,
    /// Optional crop applied to every phase frame. None = full frame.
    pub region: Option<SnapshotRegion>,
}

/// One written frame, returned to the caller so the triple comes back in
/// the tool result, not just to disk.
#[derive(Clone, Debug)]
pub struct CaptureSaved {
    pub phase: CapturePhase,
    pub path: PathBuf,
    pub bytes: usize,
}

/// The minimal client surface capture drives — modelled as injectable
/// closures so tests can inject a lightweight stub.
/// `screenshot_keeping_cursor_alive` is optional: when a client doesn't
/// expose it we degrade to a plain screenshot (matches the predown
/// fallback).
pub struct CaptureClient {
    pub screenshot: ScreenshotFn,
    pub screenshot_keeping_cursor_alive: Option<ScreenshotFn>,
}

/// The shared cursor-alive grab. Prefers `screenshot_keeping_cursor_alive`
/// (the net-zero wake-nudge that keeps the iPad cursor rendered) and falls
/// back to a plain screenshot when the client can't. Used by BOTH the
/// `PIKVM_PREDOWN_DIR` proof-shot and `capture: ["during"]` — do not
/// duplicate this branch.
pub async fn cursor_alive_grab(client: &CaptureClient) -> anyhow::Result<Vec<u8>> {
    match &client.screenshot_keeping_cursor_alive {
        Some(f) => f().await,
        None => (client.screenshot)().await,
    }
}

/// Capture one phase if it was requested. Grabs the frame ("during" via the
/// cursor-alive path, "before"/"after" via a plain screenshot), crops it to
/// `config.region`, and writes `${prefix}-${phase}.jpg`. Returns the saved
/// record, or None when the phase isn't in `config.phases` (so the caller
/// pays zero screenshots for phases it didn't ask for).
///
/// `provided_buffer` lets a caller reuse a frame it already has in hand
/// (e.g. the post-click screenshot for the "after" phase) instead of paying
/// a second grab.
///
/// This errors on a screenshot/write failure — callers that must stay
/// advisory use `capture_phase_advisory`.
pub async fn capture_phase(
    client: &CaptureClient,
    config: &CaptureConfig,
    phase: CapturePhase,
    provided_buffer: Option<Vec<u8>>,
) -> anyhow::Result<Option<CaptureSaved>> {
    if !config.phases.contains(&phase) {
        return Ok(None);
    }
    let buffer = match provided_buffer {
        Some(b) => b,
        None if phase == CapturePhase::During => cursor_alive_grab(client).await?,
        None => (client.screenshot)().await?,
    };
    let path = format!("{}-{}.jpg", config.prefix, phase.as_str());
    let saved = save_snapshot(&buffer, &path, config.region).await?;
    Ok(Some(CaptureSaved {
        phase,
        path: saved.path,
        bytes: saved.bytes,
    }))
}

/// Advisory wrapper around `capture_phase`: a capture failure returns None
/// and is swallowed so it can NEVER break the click/move it is documenting.
pub async fn capture_phase_advisory(
    client: &CaptureClient,
    config: &CaptureConfig,
    phase: CapturePhase,
    provided_buffer: Option<Vec<u8>>,
) -> Option<CaptureSaved> {
    capture_phase(client, config, phase, provided_buffer)
        .await
        .ok()
        .flatten()
}

/// Format the saved phase records for the tool-result text.
pub fn format_capture_lines(saved: &[Option<CaptureSaved>]) -> String {
    let done: Vec<&CaptureSaved> = saved.iter().filter_map(|s| s.as_ref()).collect();
    if done.is_empty() {
        return String::new();
    }
    let mut out = String::from("\nCapture:");
    for s in done {
        out.push_str(&format!(
            "\n  {}: {} ({} bytes)",
            s.phase.as_str(),
            s.path.display(),
            s.bytes
        ));
    }
    out
}

/// F12 (Round 2 Phase 5b): a stateful wrapper around `capture_phase_advisory`
/// so call sites stop repeating the "if config { push... }" pattern three
/// times each. `begin_capture` returns a session whose phase methods no-op
/// entirely (never touch the client, never allocate) when capture is off.
pub struct CaptureSession {
    client: CaptureClient,
    config: Option<CaptureConfig>,
    pub entries: Vec<Option<CaptureSaved>>,
}

impl CaptureSession {
    pub async fn before(&mut self) {
        if let Some(config) = self.config.clone() {
            let saved =
                capture_phase_advisory(&self.client, &config, CapturePhase::Before, None).await;
            self.entries.push(saved);
        }
    }

    pub async fn during(&mut self) {
        if let Some(config) = self.config.clone() {
            let saved =
                capture_phase_advisory(&self.client, &config, CapturePhase::During, None).await;
            self.entries.push(saved);
        }
    }

    /// `provided_buffer` lets a caller reuse a frame it already has in hand
    /// (e.g. moveToPixel's result.screenshot) instead of paying a second
    /// screenshot — same contract as `capture_phase`'s own `provided_buffer`.
    pub async fn after(&mut self, provided_buffer: Option<Vec<u8>>) {
        if let Some(config) = self.config.clone() {
            let saved =
                capture_phase_advisory(&self.client, &config, CapturePhase::After, provided_buffer)
                    .await;
            self.entries.push(saved);
        }
    }

    pub fn lines(&self) -> String {
        format_capture_lines(&self.entries)
    }
}

pub fn begin_capture(client: CaptureClient, config: Option<CaptureConfig>) -> CaptureSession {
    CaptureSession {
        client,
        config,
        entries: Vec::new(),
    }
}

fn require_finite_number(value: Option<&serde_json::Value>, field: &str) -> anyhow::Result<f64> {
    let n = match value {
        Some(v) if v.is_number() => v.as_f64(),
        Some(v) if v.is_string() => v.as_str().and_then(|s| s.parse::<f64>().ok()),
        _ => None,
    };
    match n {
        Some(n) if n.is_finite() => Ok(n),
        _ => anyhow::bail!("{field} must be a finite number"),
    }
}

/// Parse + validate the capture args shared by all three mouse tools.
/// Returns a `CaptureConfig`, or `None` when capture is off (arg absent or
/// an empty array = zero behavior change). Errors with a clear
/// MCP-surfaceable message when the request is malformed — notably
/// `capturePrefix` is REQUIRED once any phase is requested.
pub fn parse_capture_config(args: &serde_json::Value) -> anyhow::Result<Option<CaptureConfig>> {
    let raw = match args.get("capture") {
        None => return Ok(None),
        Some(v) if v.is_null() => return Ok(None),
        Some(v) => v,
    };
    let arr = raw.as_array().ok_or_else(|| {
        anyhow::anyhow!("capture must be an array of \"before\" | \"during\" | \"after\".")
    })?;

    let mut phases: Vec<CapturePhase> = Vec::new();
    for p in arr {
        let phase = match p.as_str() {
            Some("before") => CapturePhase::Before,
            Some("during") => CapturePhase::During,
            Some("after") => CapturePhase::After,
            _ => anyhow::bail!(
                "capture entries must each be \"before\" | \"during\" | \"after\" (got {p}).",
            ),
        };
        if !phases.contains(&phase) {
            phases.push(phase);
        }
    }
    if phases.is_empty() {
        return Ok(None); // empty array = OFF
    }

    let prefix = args
        .get("capturePrefix")
        .and_then(|v| v.as_str())
        .map(str::trim);
    let prefix = match prefix {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => anyhow::bail!("capturePrefix is required when capture requests one or more phases."),
    };

    let region = match args.get("captureRegion") {
        None => None,
        Some(v) if v.is_null() => None,
        Some(v) => Some(SnapshotRegion {
            x: require_finite_number(v.get("x"), "captureRegion.x")?,
            y: require_finite_number(v.get("y"), "captureRegion.y")?,
            width: require_finite_number(v.get("width"), "captureRegion.width")? as u32,
            height: require_finite_number(v.get("height"), "captureRegion.height")? as u32,
        }),
    };

    Ok(Some(CaptureConfig {
        phases,
        prefix,
        region,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn jpeg_4x4() -> Vec<u8> {
        let img: image::RgbImage = image::ImageBuffer::from_pixel(4, 4, image::Rgb([200, 0, 0]));
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
        encoder.encode_image(&img).unwrap();
        buf
    }

    struct Counters {
        screenshot: AtomicUsize,
        screenshot_keeping_cursor_alive: AtomicUsize,
    }

    fn make_client(jpeg: Vec<u8>) -> (CaptureClient, Arc<Counters>) {
        let counters = Arc::new(Counters {
            screenshot: AtomicUsize::new(0),
            screenshot_keeping_cursor_alive: AtomicUsize::new(0),
        });

        let c1 = counters.clone();
        let jpeg1 = jpeg.clone();
        let screenshot: ScreenshotFn = Arc::new(move || {
            c1.screenshot.fetch_add(1, Ordering::SeqCst);
            let jpeg = jpeg1.clone();
            Box::pin(async move { Ok(jpeg) })
        });

        let c2 = counters.clone();
        let jpeg2 = jpeg.clone();
        let cursor_alive: ScreenshotFn = Arc::new(move || {
            c2.screenshot_keeping_cursor_alive
                .fetch_add(1, Ordering::SeqCst);
            let jpeg = jpeg2.clone();
            Box::pin(async move { Ok(jpeg) })
        });

        (
            CaptureClient {
                screenshot,
                screenshot_keeping_cursor_alive: Some(cursor_alive),
            },
            counters,
        )
    }

    fn make_plain_client(jpeg: Vec<u8>) -> (CaptureClient, Arc<Counters>) {
        let counters = Arc::new(Counters {
            screenshot: AtomicUsize::new(0),
            screenshot_keeping_cursor_alive: AtomicUsize::new(0),
        });
        let c1 = counters.clone();
        let screenshot: ScreenshotFn = Arc::new(move || {
            c1.screenshot.fetch_add(1, Ordering::SeqCst);
            let jpeg = jpeg.clone();
            Box::pin(async move { Ok(jpeg) })
        });
        (
            CaptureClient {
                screenshot,
                screenshot_keeping_cursor_alive: None,
            },
            counters,
        )
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "m8-capture-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // --- cursor_alive_grab -------------------------------------------------

    #[tokio::test]
    async fn cursor_alive_grab_prefers_screenshot_keeping_cursor_alive() {
        let (client, counters) = make_client(jpeg_4x4());
        cursor_alive_grab(&client).await.unwrap();
        assert_eq!(
            counters
                .screenshot_keeping_cursor_alive
                .load(Ordering::SeqCst),
            1
        );
        assert_eq!(counters.screenshot.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cursor_alive_grab_falls_back_to_a_plain_screenshot() {
        let (client, counters) = make_plain_client(jpeg_4x4());
        cursor_alive_grab(&client).await.unwrap();
        assert_eq!(counters.screenshot.load(Ordering::SeqCst), 1);
    }

    // --- capture_phase -------------------------------------------------------

    #[tokio::test]
    async fn writes_prefix_phase_jpg_for_a_requested_phase() {
        let (client, _counters) = make_client(jpeg_4x4());
        let dir = temp_dir();
        let prefix = dir.join("shot").to_str().unwrap().to_string();
        let config = CaptureConfig {
            phases: vec![CapturePhase::Before],
            prefix: prefix.clone(),
            region: None,
        };
        let saved = capture_phase(&client, &config, CapturePhase::Before, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            saved.path,
            std::path::absolute(format!("{prefix}-before.jpg")).unwrap()
        );
        assert!(saved.bytes > 0);
        assert!(tokio::fs::metadata(&saved.path).await.is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn returns_none_and_takes_zero_screenshots_for_a_phase_not_requested() {
        let (client, counters) = make_client(jpeg_4x4());
        let dir = temp_dir();
        let config = CaptureConfig {
            phases: vec![CapturePhase::Before],
            prefix: dir.join("s").to_str().unwrap().to_string(),
            region: None,
        };
        let saved = capture_phase(&client, &config, CapturePhase::After, None)
            .await
            .unwrap();
        assert!(saved.is_none());
        assert_eq!(counters.screenshot.load(Ordering::SeqCst), 0);
        assert_eq!(
            counters
                .screenshot_keeping_cursor_alive
                .load(Ordering::SeqCst),
            0
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn during_goes_through_the_cursor_alive_path_not_a_plain_screenshot() {
        let (client, counters) = make_client(jpeg_4x4());
        let dir = temp_dir();
        let config = CaptureConfig {
            phases: vec![CapturePhase::During],
            prefix: dir.join("s").to_str().unwrap().to_string(),
            region: None,
        };
        capture_phase(&client, &config, CapturePhase::During, None)
            .await
            .unwrap();
        assert_eq!(
            counters
                .screenshot_keeping_cursor_alive
                .load(Ordering::SeqCst),
            1
        );
        assert_eq!(counters.screenshot.load(Ordering::SeqCst), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn before_after_use_a_plain_screenshot_not_the_cursor_alive_nudge() {
        let (client, counters) = make_client(jpeg_4x4());
        let dir = temp_dir();
        let config = CaptureConfig {
            phases: vec![CapturePhase::Before, CapturePhase::After],
            prefix: dir.join("s").to_str().unwrap().to_string(),
            region: None,
        };
        capture_phase(&client, &config, CapturePhase::Before, None)
            .await
            .unwrap();
        capture_phase(&client, &config, CapturePhase::After, None)
            .await
            .unwrap();
        assert_eq!(counters.screenshot.load(Ordering::SeqCst), 2);
        assert_eq!(
            counters
                .screenshot_keeping_cursor_alive
                .load(Ordering::SeqCst),
            0
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn reuses_a_provided_buffer_instead_of_grabbing_a_new_frame() {
        let (client, counters) = make_client(jpeg_4x4());
        let dir = temp_dir();
        let config = CaptureConfig {
            phases: vec![CapturePhase::After],
            prefix: dir.join("s").to_str().unwrap().to_string(),
            region: None,
        };
        let saved = capture_phase(&client, &config, CapturePhase::After, Some(jpeg_4x4()))
            .await
            .unwrap();
        assert!(saved.is_some());
        assert_eq!(counters.screenshot.load(Ordering::SeqCst), 0);
        assert_eq!(
            counters
                .screenshot_keeping_cursor_alive
                .load(Ordering::SeqCst),
            0
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn applies_capture_region_as_a_crop() {
        let (client, _counters) = make_client(jpeg_4x4());
        let dir = temp_dir();
        let config = CaptureConfig {
            phases: vec![CapturePhase::Before],
            prefix: dir.join("s").to_str().unwrap().to_string(),
            region: Some(SnapshotRegion {
                x: 0.0,
                y: 0.0,
                width: 2,
                height: 2,
            }),
        };
        let saved = capture_phase(&client, &config, CapturePhase::Before, None)
            .await
            .unwrap()
            .unwrap();
        let bytes = tokio::fs::read(&saved.path).await.unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.width(), 2);
        assert_eq!(decoded.height(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- capture_phase_advisory ----------------------------------------------

    #[tokio::test]
    async fn capture_phase_advisory_swallows_a_capture_failure_and_returns_none() {
        let screenshot: ScreenshotFn =
            Arc::new(|| Box::pin(async { anyhow::bail!("streamer 503") }));
        let boom = CaptureClient {
            screenshot,
            screenshot_keeping_cursor_alive: None,
        };
        let dir = temp_dir();
        let config = CaptureConfig {
            phases: vec![CapturePhase::Before],
            prefix: dir.join("s").to_str().unwrap().to_string(),
            region: None,
        };
        let saved = capture_phase_advisory(&boom, &config, CapturePhase::Before, None).await;
        assert!(saved.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- parse_capture_config --------------------------------------------------

    #[test]
    fn returns_none_when_capture_is_absent() {
        assert!(parse_capture_config(&json!({})).unwrap().is_none());
        assert!(parse_capture_config(&json!({"capture": null}))
            .unwrap()
            .is_none());
    }

    #[test]
    fn returns_none_for_an_empty_array() {
        assert!(parse_capture_config(&json!({"capture": []}))
            .unwrap()
            .is_none());
    }

    #[test]
    fn parses_phases_prefix_and_region() {
        let cfg = parse_capture_config(&json!({
            "capture": ["before", "during", "after"],
            "capturePrefix": "/tmp/run",
            "captureRegion": {"x": 1, "y": 2, "width": 3, "height": 4},
        }))
        .unwrap()
        .unwrap();
        assert_eq!(
            cfg.phases,
            vec![
                CapturePhase::Before,
                CapturePhase::During,
                CapturePhase::After
            ]
        );
        assert_eq!(cfg.prefix, "/tmp/run");
        let region = cfg.region.unwrap();
        assert_eq!(
            (region.x, region.y, region.width, region.height),
            (1.0, 2.0, 3, 4)
        );
    }

    #[test]
    fn deduplicates_phases_while_preserving_order() {
        let cfg = parse_capture_config(&json!({
            "capture": ["after", "before", "after", "before"],
            "capturePrefix": "/tmp/run",
        }))
        .unwrap()
        .unwrap();
        assert_eq!(cfg.phases, vec![CapturePhase::After, CapturePhase::Before]);
    }

    #[test]
    fn throws_when_capture_prefix_is_missing_but_phases_are_requested() {
        let err = parse_capture_config(&json!({"capture": ["during"]})).unwrap_err();
        assert!(err.to_string().contains("capturePrefix is required"));
        let err = parse_capture_config(&json!({"capture": ["during"], "capturePrefix": "   "}))
            .unwrap_err();
        assert!(err.to_string().contains("capturePrefix is required"));
    }

    #[test]
    fn throws_on_an_unknown_phase_name() {
        let err = parse_capture_config(&json!({"capture": ["midtap"], "capturePrefix": "/t/x"}))
            .unwrap_err();
        assert!(err.to_string().contains("before"));
        assert!(err.to_string().contains("during"));
        assert!(err.to_string().contains("after"));
    }

    #[test]
    fn throws_on_a_non_array_capture() {
        let err = parse_capture_config(&json!({"capture": "during", "capturePrefix": "/t/x"}))
            .unwrap_err();
        assert!(err.to_string().contains("must be an array"));
    }

    #[test]
    fn throws_on_a_non_numeric_capture_region_field() {
        let err = parse_capture_config(&json!({
            "capture": ["before"],
            "capturePrefix": "/t/x",
            "captureRegion": {"x": 0, "y": 0, "width": "wide", "height": 4},
        }))
        .unwrap_err();
        assert!(err.to_string().contains("captureRegion.width"));
    }

    // --- begin_capture / CaptureSession -------------------------------------

    #[tokio::test]
    async fn is_a_true_no_op_when_config_is_none() {
        let (client, counters) = make_client(jpeg_4x4());
        let mut session = begin_capture(client, None);
        session.before().await;
        session.during().await;
        session.after(None).await;
        assert_eq!(counters.screenshot.load(Ordering::SeqCst), 0);
        assert_eq!(
            counters
                .screenshot_keeping_cursor_alive
                .load(Ordering::SeqCst),
            0
        );
        assert!(session.entries.is_empty());
        assert_eq!(session.lines(), "");
    }

    #[tokio::test]
    async fn accumulates_before_during_after_into_entries_and_formats_them() {
        let (client, _counters) = make_client(jpeg_4x4());
        let dir = temp_dir();
        let config = CaptureConfig {
            phases: vec![
                CapturePhase::Before,
                CapturePhase::During,
                CapturePhase::After,
            ],
            prefix: dir.join("s").to_str().unwrap().to_string(),
            region: None,
        };
        let mut session = begin_capture(client, Some(config));
        session.before().await;
        session.during().await;
        session.after(None).await;
        assert_eq!(session.entries.len(), 3);
        assert!(session.entries.iter().all(|e| e.is_some()));
        let lines = session.lines();
        assert!(lines.contains("Capture:"));
        assert!(lines.contains("before:"));
        assert!(lines.contains("during:"));
        assert!(lines.contains("after:"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn after_with_provided_buffer_reuses_it_instead_of_grabbing_a_new_frame() {
        let (client, counters) = make_client(jpeg_4x4());
        let dir = temp_dir();
        let config = CaptureConfig {
            phases: vec![CapturePhase::After],
            prefix: dir.join("s").to_str().unwrap().to_string(),
            region: None,
        };
        let mut session = begin_capture(client, Some(config));
        session.after(Some(jpeg_4x4())).await;
        assert_eq!(counters.screenshot.load(Ordering::SeqCst), 0);
        assert_eq!(
            counters
                .screenshot_keeping_cursor_alive
                .load(Ordering::SeqCst),
            0
        );
        assert_eq!(session.entries.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_phase_not_in_config_phases_records_a_none_entry() {
        let (client, _counters) = make_client(jpeg_4x4());
        let dir = temp_dir();
        let config = CaptureConfig {
            phases: vec![CapturePhase::Before],
            prefix: dir.join("s").to_str().unwrap().to_string(),
            region: None,
        };
        let mut session = begin_capture(client, Some(config));
        session.after(None).await; // 'after' not requested
        assert_eq!(session.entries.len(), 1);
        assert!(session.entries[0].is_none());
        assert_eq!(session.lines(), "");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
