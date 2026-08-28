//! Persist a cursor template to disk for reuse across invocations.
//!
//! Split out of `cursor_detect.rs` (idiomatic Rust 2018+ module layout —
//! see this module's root file for why).

use super::template::{compute_template_hotspot, CursorTemplate};
use crate::decode::decode_to_rgb;

/// Persist a cursor template to disk for reuse across invocations.
pub async fn save_cursor_template(
    template: &CursorTemplate,
    file_path: &str,
) -> anyhow::Result<()> {
    let path = std::path::Path::new(file_path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let img: image::RgbImage =
        image::ImageBuffer::from_raw(template.width, template.height, template.rgb.clone())
            .ok_or_else(|| {
                anyhow::anyhow!("save_cursor_template: rgb buffer doesn't match width*height*3")
            })?;
    let mut buf = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
    encoder.encode_image(&img)?;
    tokio::fs::write(path, &buf).await?;
    Ok(())
}

/// Load a cursor template previously written by `save_cursor_template`.
/// Returns None if the file is missing.
pub async fn load_cursor_template(file_path: &str) -> anyhow::Result<Option<CursorTemplate>> {
    let buf = match tokio::fs::read(file_path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let decoded = decode_to_rgb(&buf)?;
    let mut tpl = CursorTemplate {
        rgb: decoded.data,
        width: decoded.width,
        height: decoded.height,
        hotspot: None,
    };
    // Legacy disk-format templates don't carry a hotspot; recompute it from
    // the loaded pixel data so callers report the cursor TIP, not
    // bbox-centre.
    tpl.hotspot = Some(compute_template_hotspot(&tpl));
    Ok(Some(tpl))
}
