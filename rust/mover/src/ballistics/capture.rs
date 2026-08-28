//! ADR-0001's non-nudging screenshot capture: a wake nudge right before a
//! calibration/ballistics capture would contaminate the very displacement
//! being measured. Faithful port of `takeRawScreenshot`. See
//! `docs/adr/0001-do-not-merge-cursor-detection-and-calibration-sampling-
//! lookalikes.md`.

use pikvm_mcp_kvmd_client::client::{ClientError, PiKVMClient};

pub async fn take_raw_screenshot(client: &PiKVMClient) -> Result<Vec<u8>, ClientError> {
    Ok(client.screenshot(None).await?.buffer)
}
