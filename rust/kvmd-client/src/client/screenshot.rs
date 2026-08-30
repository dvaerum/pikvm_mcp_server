//! Screenshot capture + resolution/streamer-status queries.

use super::core::{parse_resolution, streamer_source, PiKVMClient, ScreenshotScale};
use super::error::ClientError;
use super::types::{ScreenResolution, ScreenshotOptions, ScreenshotResult};

impl PiKVMClient {
    /// Phase 202: emit a ±1px wake nudge IMMEDIATELY before capturing a
    /// screenshot so the iPad's soft cursor is visible in the captured
    /// frame. Net cursor displacement is 0 (1 right + 1 left).
    pub async fn screenshot_keeping_cursor_alive(
        &self,
        options: Option<ScreenshotOptions>,
    ) -> Result<ScreenshotResult, ClientError> {
        // If the wake nudge fails (HID busy etc.), proceed with the
        // screenshot anyway — degraded behavior matches the old path;
        // better than throwing here.
        let _ = self.mouse_move_relative(1.0, 0.0).await;
        let _ = self.mouse_move_relative(-1.0, 0.0).await;
        self.screenshot(options).await
    }

    pub async fn screenshot(
        &self,
        options: Option<ScreenshotOptions>,
    ) -> Result<ScreenshotResult, ClientError> {
        let options = options.unwrap_or_default();
        let mut params = Vec::new();
        if options.max_width.is_some() || options.max_height.is_some() {
            params.push("preview=1".to_string());
            if let Some(w) = options.max_width {
                params.push(format!("preview_max_width={w}"));
            }
            if let Some(h) = options.max_height {
                params.push(format!("preview_max_height={h}"));
            }
            if let Some(q) = options.quality {
                params.push(format!("preview_quality={q}"));
            }
        }
        let path = if params.is_empty() {
            "/streamer/snapshot".to_string()
        } else {
            format!("/streamer/snapshot?{}", params.join("&"))
        };
        let buffer = self
            .fetch_snapshot_with_retry(&path, options.allow_keyboard_wake)
            .await?;

        // Force-refresh resolution to ensure accuracy.
        let actual_resolution = self.get_resolution(true).await?;

        let dims = image::load_from_memory(&buffer)
            .map_err(|_| ClientError::Other("Failed to read screenshot dimensions".to_string()))?;
        let (width, height) = (dims.width(), dims.height());

        let scale_x = actual_resolution.width as f64 / width as f64;
        let scale_y = actual_resolution.height as f64 / height as f64;
        *self.screenshot_scale.lock().unwrap() = Some(ScreenshotScale { scale_x, scale_y });

        Ok(ScreenshotResult {
            buffer,
            screenshot_width: width,
            screenshot_height: height,
            actual_width: actual_resolution.width,
            actual_height: actual_resolution.height,
            scale_x,
            scale_y,
        })
    }

    pub async fn get_resolution(
        &self,
        force_refresh: bool,
    ) -> Result<ScreenResolution, ClientError> {
        if !force_refresh {
            if let Some(r) = *self.cached_resolution.lock().unwrap() {
                return Ok(r);
            }
        }
        let response = self.fetch_streamer_state_with_retry().await?;
        let resolution = streamer_source(&response)
            .and_then(|s| s.get("resolution"))
            .and_then(parse_resolution)
            .ok_or_else(|| {
                ClientError::Other(
                    "Invalid or missing resolution data from PiKVM streamer API".into(),
                )
            })?;
        *self.cached_resolution.lock().unwrap() = Some(resolution);
        Ok(resolution)
    }

    /// Phase 189: report streamer source state — whether the HDMI capture
    /// is seeing a signal (device powered on and outputting video).
    pub async fn get_streamer_status(&self) -> Result<(bool, ScreenResolution), ClientError> {
        let response = self.fetch_streamer_state_with_retry().await?;
        let source = streamer_source(&response).ok_or_else(|| {
            ClientError::Other("Invalid or missing streamer.source data from PiKVM API".into())
        })?;
        let online = source
            .get("online")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| {
                ClientError::Other("Invalid or missing streamer.source data from PiKVM API".into())
            })?;
        let resolution = source
            .get("resolution")
            .and_then(parse_resolution)
            .ok_or_else(|| {
                ClientError::Other(
                    "Invalid or missing streamer.source.resolution data from PiKVM API".into(),
                )
            })?;
        Ok((online, resolution))
    }
}
