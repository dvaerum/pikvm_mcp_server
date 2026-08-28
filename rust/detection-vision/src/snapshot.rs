//! Save a PiKVM video-frame JPEG to a file (M5). Backs `pikvm_snapshot` and
//! the `savePath` option on `pikvm_screenshot`.
//!
//! Faithful port of `src/pikvm/snapshot.ts`. Kept as its own module so the
//! crop + write is unit-testable without a live PiKVM (ground truth: the
//! file exists and decodes as a JPEG).

use std::path::PathBuf;

/// An axis-aligned crop region in screenshot pixels.
#[derive(Clone, Copy, Debug)]
pub struct SnapshotRegion {
    pub x: f64,
    pub y: f64,
    pub width: u32,
    pub height: u32,
}

pub struct SavedSnapshot {
    pub path: PathBuf,
    pub bytes: usize,
}

/// Optionally crop `buffer` to `region`, then write it to `save_path`
/// (creating parent directories). Returns the resolved absolute path +
/// byte count.
///
/// The write target is whatever the caller passes — under the hardened
/// systemd service the process can only write within its
/// StateDirectory/PrivateTmp, so absolute paths outside those will fail
/// with a permission error; a local dev invocation is unrestricted.
pub async fn save_snapshot(
    buffer: &[u8],
    save_path: &str,
    region: Option<SnapshotRegion>,
) -> anyhow::Result<SavedSnapshot> {
    if save_path.trim().is_empty() {
        anyhow::bail!("save_snapshot: savePath is required");
    }
    let out: Vec<u8> = if let Some(r) = region {
        let img = image::load_from_memory(buffer)?;
        let left = r.x.max(0.0).round() as u32;
        let top = r.y.max(0.0).round() as u32;
        let cropped = img.crop_imm(left, top, r.width, r.height);
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        cropped
            .to_rgb8()
            .write_to(&mut cursor, image::ImageFormat::Jpeg)?;
        buf
    } else {
        buffer.to_vec()
    };
    // The parent dir may not exist yet (that's exactly the case we need to
    // create below), so resolve via std::path::absolute (pure path math, no
    // filesystem access) rather than canonicalize, matching Node's
    // path.resolve() semantics (does not require the path to exist).
    let resolved = std::path::absolute(save_path)?;
    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&resolved, &out).await?;
    Ok(SavedSnapshot {
        path: resolved,
        bytes: out.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    use std::path::Path;

    fn jpeg(w: u32, h: u32, v: u8) -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(w, h, Rgb([v, v, v]));
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        img.write_to(&mut cursor, image::ImageFormat::Jpeg).unwrap();
        buf
    }

    #[tokio::test]
    async fn writes_the_frame_to_save_path_and_it_decodes_as_a_jpeg() {
        let dir = tempfile_dir();
        let buf = jpeg(64, 48, 128);
        let target = dir.join("nested").join("frame.jpg"); // parent dir doesn't exist yet

        let res = save_snapshot(&buf, target.to_str().unwrap(), None)
            .await
            .unwrap();

        assert_eq!(res.path, std::path::absolute(&target).unwrap());
        assert_eq!(res.bytes, buf.len());
        let written = tokio::fs::read(&target).await.unwrap();
        let decoded = image::load_from_memory(&written).unwrap();
        assert_eq!(decoded.width(), 64);
        assert_eq!(decoded.height(), 48);

        cleanup(&dir);
    }

    #[tokio::test]
    async fn crops_to_region_before_writing_output_dimensions_equal_region() {
        let dir = tempfile_dir();
        let buf = jpeg(100, 100, 128);
        let target = dir.join("crop.jpg");

        save_snapshot(
            &buf,
            target.to_str().unwrap(),
            Some(SnapshotRegion {
                x: 10.0,
                y: 20.0,
                width: 30,
                height: 40,
            }),
        )
        .await
        .unwrap();

        let written = tokio::fs::read(&target).await.unwrap();
        let decoded = image::load_from_memory(&written).unwrap();
        assert_eq!(decoded.width(), 30);
        assert_eq!(decoded.height(), 40);

        cleanup(&dir);
    }

    #[tokio::test]
    async fn rejects_an_empty_save_path() {
        let buf = jpeg(8, 8, 128);
        let result = save_snapshot(&buf, "", None).await;
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap()
            .to_string()
            .contains("savePath is required"));
    }

    fn tempfile_dir() -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("pikvm-snap-test-{}", std::process::id()))
            .join(format!(
                "{:?}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
            ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }
}
