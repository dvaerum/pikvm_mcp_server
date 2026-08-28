//! Shared JPEG-decode-to-raw-RGB primitive.
//!
//! Faithful port of `decodeToRgb` (`src/pikvm/cursor-detect.ts`). Small and
//! reused by multiple module-3 files (orientation.ts, cursor-detect.ts
//! itself, ...) — kept as its own module here rather than duplicated at
//! each call site.

pub struct DecodedRgb {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub fn decode_to_rgb(buffer: &[u8]) -> anyhow::Result<DecodedRgb> {
    let img = image::load_from_memory(buffer)?;
    let rgb = img.to_rgb8();
    let (width, height) = (rgb.width(), rgb.height());
    Ok(DecodedRgb {
        data: rgb.into_raw(),
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    #[test]
    fn decode_to_rgb_returns_correct_dimensions_and_pixel_data() {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(4, 3, |x, y| {
            if x == 0 && y == 0 {
                Rgb([255, 0, 0])
            } else {
                Rgb([0, 0, 0])
            }
        });
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 100);
        encoder.encode_image(&img).unwrap();

        let decoded = decode_to_rgb(&buf).unwrap();
        assert_eq!(decoded.width, 4);
        assert_eq!(decoded.height, 3);
        assert_eq!(decoded.data.len(), 4 * 3 * 3);
        // JPEG is lossy, but a pure-red pixel at (0,0) should still read
        // clearly red-dominant after decode.
        assert!(decoded.data[0] > decoded.data[1]);
        assert!(decoded.data[0] > decoded.data[2]);
    }
}
