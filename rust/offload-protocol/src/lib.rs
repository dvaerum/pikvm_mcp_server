//! Wire codec for the cascade-inference offload protocol (`task_d06561d91f58`).
//!
//! Every WS binary frame is a 16-byte header followed by a
//! `msg_type`-specific payload. All multi-byte integers are big-endian
//! ("network byte order"). See `docs/cursor-offload-inference-design.md`
//! §2 for the protocol this is a faithful implementation of.

use anyhow::{bail, ensure, Context, Result};
use pikvm_mcp_detection_vision::cursor_ml_detect::{CascadeResult, RawCrop};

pub const MAGIC: [u8; 4] = *b"PKOF";
pub const VERSION: u8 = 1;
const HEADER_LEN: usize = 16;

/// The WS-layer message/frame size limit BOTH sides must configure --
/// `tungstenite`'s own defaults (`max_message_size` 64 MiB,
/// `max_frame_size` 16 MiB, confirmed against its source) are too small
/// for a real `InferRequest`: a full no-hint desktop-target scan (the
/// FULL FRAME region, not the iPad's narrower tight region) can produce
/// ~900+ 96px crops, ~25 MiB of raw crop bytes -- comfortably over the 16
/// MiB `max_frame_size` default, found live during task_d06561d91f58's
/// own real-hardware correctness gate (it-03400): every such call was
/// silently falling back to local inference, the WS send/receive
/// rejecting the oversized frame before ever reaching the wire codec
/// itself. A single shared constant here (not two independently-chosen
/// numbers on each side) is deliberate -- a mismatch would just move the
/// same silent-fallback failure to whichever side has the smaller limit.
/// 128 MiB is several times a realistic worst-case single-frame scan,
/// not merely large enough for today's numbers.
pub const MAX_WS_MESSAGE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MsgType {
    Hello = 1,
    HelloAck = 2,
    InferRequest = 3,
    InferResponse = 4,
    Error = 5,
}

impl MsgType {
    fn from_u8(v: u8) -> Result<Self> {
        Ok(match v {
            1 => MsgType::Hello,
            2 => MsgType::HelloAck,
            3 => MsgType::InferRequest,
            4 => MsgType::InferResponse,
            5 => MsgType::Error,
            other => bail!("offload-protocol: unknown msg_type {other}"),
        })
    }
}

/// One offload-protocol wire frame. `request_id` correlates an
/// `InferRequest` with the `InferResponse` (or `Error`) that answers it;
/// `Hello`/`HelloAck` don't have an in-flight request yet, so they ignore it
/// (always encoded as 0, ignored on decode).
#[derive(Clone, Debug)]
pub enum Frame {
    /// helper→server: proves model identity. Auth already happened at the
    /// HTTP-upgrade step (bearer token header) — this is identity, not auth.
    Hello {
        model_sha256: [u8; 32],
        label: String,
    },
    /// server→helper: `reason` is populated only when `accepted` is false
    /// (e.g. a model-hash mismatch). The connection is closed after a
    /// rejection.
    HelloAck { accepted: bool, reason: String },
    /// server→helper: a batch of raw, unnormalized RGB crops to run
    /// inference on.
    InferRequest {
        request_id: u32,
        frame_w: u32,
        frame_h: u32,
        crop_size: u32,
        crops: Vec<RawCrop>,
    },
    /// helper→server: results in the same order as the request's crops.
    /// `results.len()` must equal the request's `crops.len()` — a mismatch
    /// is a protocol error the caller should treat as "fall back to local
    /// for this request, keep the connection alive", not decode-time UB.
    InferResponse {
        request_id: u32,
        results: Vec<CascadeResult>,
    },
    /// either direction: a human-readable protocol/application error.
    Error { request_id: u32, message: String },
}

/// Serialize a [`Frame`] to its wire bytes: 16-byte header + payload.
pub fn encode(frame: &Frame) -> Result<Vec<u8>> {
    let (msg_type, request_id, payload) = match frame {
        Frame::Hello {
            model_sha256,
            label,
        } => {
            let mut p = Vec::with_capacity(32 + 4 + label.len());
            p.extend_from_slice(model_sha256);
            write_string(&mut p, label);
            (MsgType::Hello, 0, p)
        }
        Frame::HelloAck { accepted, reason } => {
            let mut p = Vec::with_capacity(1 + 4 + reason.len());
            p.push(u8::from(*accepted));
            write_string(&mut p, reason);
            (MsgType::HelloAck, 0, p)
        }
        Frame::InferRequest {
            request_id,
            frame_w,
            frame_h,
            crop_size,
            crops,
        } => {
            let mut p = Vec::new();
            p.extend_from_slice(&frame_w.to_be_bytes());
            p.extend_from_slice(&frame_h.to_be_bytes());
            p.extend_from_slice(&crop_size.to_be_bytes());
            let crop_count: u32 = crops
                .len()
                .try_into()
                .context("offload-protocol: crop_count overflows u32")?;
            p.extend_from_slice(&crop_count.to_be_bytes());
            for crop in crops {
                p.extend_from_slice(&crop.center.0.to_be_bytes());
                p.extend_from_slice(&crop.center.1.to_be_bytes());
                p.extend_from_slice(&crop.bytes);
            }
            (MsgType::InferRequest, *request_id, p)
        }
        Frame::InferResponse {
            request_id,
            results,
        } => {
            let mut p = Vec::new();
            let crop_count: u32 = results
                .len()
                .try_into()
                .context("offload-protocol: crop_count overflows u32")?;
            p.extend_from_slice(&crop_count.to_be_bytes());
            for r in results {
                p.extend_from_slice(&r.x.to_be_bytes());
                p.extend_from_slice(&r.y.to_be_bytes());
                p.extend_from_slice(&r.presence.to_be_bytes());
                p.extend_from_slice(&r.heatmap_peak.to_be_bytes());
            }
            (MsgType::InferResponse, *request_id, p)
        }
        Frame::Error {
            request_id,
            message,
        } => {
            let mut p = Vec::with_capacity(4 + message.len());
            write_string(&mut p, message);
            (MsgType::Error, *request_id, p)
        }
    };

    let payload_len: u32 = payload
        .len()
        .try_into()
        .context("offload-protocol: payload_len overflows u32")?;

    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    out.push(msg_type as u8);
    out.push(0); // flags: reserved, unused in v1
    out.push(0); // _pad: reserved, unused in v1
    out.extend_from_slice(&request_id.to_be_bytes());
    out.extend_from_slice(&payload_len.to_be_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

/// Parse wire bytes back into a [`Frame`]. Every length used to slice `bytes`
/// is bounds-checked before use — this parses untrusted network input, so a
/// truncated or malformed frame must return `Err`, never panic or read out
/// of bounds.
pub fn decode(bytes: &[u8]) -> Result<Frame> {
    ensure!(
        bytes.len() >= HEADER_LEN,
        "offload-protocol: frame shorter than the 16-byte header ({} bytes)",
        bytes.len()
    );
    ensure!(
        bytes[0..4] == MAGIC,
        "offload-protocol: bad magic {:?}, expected {:?}",
        &bytes[0..4],
        MAGIC
    );
    let version = bytes[4];
    ensure!(
        version == VERSION,
        "offload-protocol: unsupported version {version}, expected {VERSION}"
    );
    let msg_type = MsgType::from_u8(bytes[5])?;
    // bytes[6] = flags, bytes[7] = _pad: reserved, ignored in v1.
    let request_id = u32::from_be_bytes(bytes[8..12].try_into().unwrap());
    let payload_len = u32::from_be_bytes(bytes[12..16].try_into().unwrap()) as usize;
    let payload = &bytes[HEADER_LEN..];
    ensure!(
        payload.len() == payload_len,
        "offload-protocol: payload_len {payload_len} doesn't match actual payload {} bytes",
        payload.len()
    );

    let mut r = Reader::new(payload);
    Ok(match msg_type {
        MsgType::Hello => {
            let model_sha256: [u8; 32] = r.read_bytes(32)?.try_into().unwrap();
            let label = r.read_string()?;
            r.finish()?;
            Frame::Hello {
                model_sha256,
                label,
            }
        }
        MsgType::HelloAck => {
            let accepted = r.read_u8()? != 0;
            let reason = r.read_string()?;
            r.finish()?;
            Frame::HelloAck { accepted, reason }
        }
        MsgType::InferRequest => {
            let frame_w = r.read_u32()?;
            let frame_h = r.read_u32()?;
            let crop_size = r.read_u32()?;
            let crop_count = r.read_u32()? as usize;
            let crop_bytes_len = (crop_size as usize)
                .checked_mul(crop_size as usize)
                .and_then(|a| a.checked_mul(3))
                .context("offload-protocol: crop_size too large, byte-length overflow")?;
            let mut crops = Vec::with_capacity(crop_count);
            for _ in 0..crop_count {
                let cx = r.read_i64()?;
                let cy = r.read_i64()?;
                let bytes = r.read_bytes(crop_bytes_len)?.to_vec();
                crops.push(RawCrop {
                    center: (cx, cy),
                    bytes,
                });
            }
            r.finish()?;
            Frame::InferRequest {
                request_id,
                frame_w,
                frame_h,
                crop_size,
                crops,
            }
        }
        MsgType::InferResponse => {
            let crop_count = r.read_u32()? as usize;
            let mut results = Vec::with_capacity(crop_count);
            for _ in 0..crop_count {
                let x = r.read_i64()?;
                let y = r.read_i64()?;
                let presence = r.read_f32()?;
                let heatmap_peak = r.read_f32()?;
                results.push(CascadeResult {
                    x,
                    y,
                    presence,
                    heatmap_peak,
                });
            }
            r.finish()?;
            Frame::InferResponse {
                request_id,
                results,
            }
        }
        MsgType::Error => {
            let message = r.read_string()?;
            r.finish()?;
            Frame::Error {
                request_id,
                message,
            }
        }
    })
}

/// A bounds-checked cursor over a payload slice. Every `read_*` returns
/// `Err` on truncated input rather than panicking — the payload is
/// untrusted network data.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn read_bytes(&mut self, len: usize) -> Result<&'a [u8]> {
        ensure!(
            self.pos + len <= self.buf.len(),
            "offload-protocol: truncated payload (wanted {len} bytes at offset {}, have {})",
            self.pos,
            self.buf.len()
        );
        let slice = &self.buf[self.pos..self.pos + len];
        self.pos += len;
        Ok(slice)
    }

    fn read_u8(&mut self) -> Result<u8> {
        Ok(self.read_bytes(1)?[0])
    }

    fn read_u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.read_bytes(4)?.try_into().unwrap()))
    }

    fn read_i64(&mut self) -> Result<i64> {
        Ok(i64::from_be_bytes(self.read_bytes(8)?.try_into().unwrap()))
    }

    fn read_f32(&mut self) -> Result<f32> {
        Ok(f32::from_be_bytes(self.read_bytes(4)?.try_into().unwrap()))
    }

    fn read_string(&mut self) -> Result<String> {
        let len = self.read_u32()? as usize;
        let bytes = self.read_bytes(len)?;
        String::from_utf8(bytes.to_vec())
            .context("offload-protocol: string field isn't valid UTF-8")
    }

    /// Confirms every byte of the payload was consumed — a leftover tail
    /// means the declared payload doesn't match what this msg_type actually
    /// encodes, which is a real protocol-mismatch bug, not something to
    /// silently ignore.
    fn finish(&self) -> Result<()> {
        ensure!(
            self.pos == self.buf.len(),
            "offload-protocol: {} trailing byte(s) after decoding a known msg_type",
            self.buf.len() - self.pos
        );
        Ok(())
    }
}

fn write_string(out: &mut Vec<u8>, s: &str) {
    let len = s.len() as u32;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(s.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(frame: Frame) -> Frame {
        let bytes = encode(&frame).expect("encode");
        decode(&bytes).expect("decode")
    }

    #[test]
    fn hello_round_trips_exactly() {
        let frame = Frame::Hello {
            model_sha256: [7u8; 32],
            label: "mac-mini".to_string(),
        };
        match roundtrip(frame) {
            Frame::Hello {
                model_sha256,
                label,
            } => {
                assert_eq!(model_sha256, [7u8; 32]);
                assert_eq!(label, "mac-mini");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn hello_ack_accepted_round_trips_with_empty_reason() {
        let frame = Frame::HelloAck {
            accepted: true,
            reason: String::new(),
        };
        match roundtrip(frame) {
            Frame::HelloAck { accepted, reason } => {
                assert!(accepted);
                assert_eq!(reason, "");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn hello_ack_rejected_round_trips_with_reason() {
        let frame = Frame::HelloAck {
            accepted: false,
            reason: "model hash mismatch".to_string(),
        };
        match roundtrip(frame) {
            Frame::HelloAck { accepted, reason } => {
                assert!(!accepted);
                assert_eq!(reason, "model hash mismatch");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn infer_request_round_trips_exact_crop_bytes_and_order() {
        let crops = vec![
            RawCrop {
                center: (10, 20),
                bytes: vec![1u8; 96 * 96 * 3],
            },
            RawCrop {
                center: (-5, -30),
                bytes: vec![2u8; 96 * 96 * 3],
            },
        ];
        let frame = Frame::InferRequest {
            request_id: 42,
            frame_w: 1920,
            frame_h: 1080,
            crop_size: 96,
            crops,
        };
        match roundtrip(frame) {
            Frame::InferRequest {
                request_id,
                frame_w,
                frame_h,
                crop_size,
                crops,
            } => {
                assert_eq!(request_id, 42);
                assert_eq!(frame_w, 1920);
                assert_eq!(frame_h, 1080);
                assert_eq!(crop_size, 96);
                assert_eq!(crops.len(), 2);
                assert_eq!(crops[0].center, (10, 20));
                assert_eq!(crops[0].bytes, vec![1u8; 96 * 96 * 3]);
                assert_eq!(crops[1].center, (-5, -30));
                assert_eq!(crops[1].bytes, vec![2u8; 96 * 96 * 3]);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn infer_request_with_zero_crops_round_trips() {
        let frame = Frame::InferRequest {
            request_id: 1,
            frame_w: 100,
            frame_h: 100,
            crop_size: 96,
            crops: vec![],
        };
        match roundtrip(frame) {
            Frame::InferRequest { crops, .. } => assert!(crops.is_empty()),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn infer_response_round_trips_exact_values_and_order() {
        let results = vec![
            CascadeResult {
                x: 100,
                y: 200,
                presence: 0.987,
                heatmap_peak: 0.654,
            },
            CascadeResult {
                x: -1,
                y: -1,
                presence: 0.0,
                heatmap_peak: 0.0,
            },
        ];
        let frame = Frame::InferResponse {
            request_id: 42,
            results,
        };
        match roundtrip(frame) {
            Frame::InferResponse {
                request_id,
                results,
            } => {
                assert_eq!(request_id, 42);
                assert_eq!(results.len(), 2);
                assert_eq!(results[0].x, 100);
                assert_eq!(results[0].y, 200);
                assert_eq!(results[0].presence, 0.987);
                assert_eq!(results[0].heatmap_peak, 0.654);
                assert_eq!(results[1].x, -1);
                assert_eq!(results[1].y, -1);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn error_round_trips_with_request_id_and_message() {
        let frame = Frame::Error {
            request_id: 7,
            message: "crop_count mismatch".to_string(),
        };
        match roundtrip(frame) {
            Frame::Error {
                request_id,
                message,
            } => {
                assert_eq!(request_id, 7);
                assert_eq!(message, "crop_count mismatch");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn decode_rejects_frame_shorter_than_header() {
        assert!(decode(&[b'P', b'K', b'O', b'F', 1]).is_err());
    }

    #[test]
    fn decode_rejects_bad_magic() {
        let mut bytes = encode(&Frame::Error {
            request_id: 0,
            message: "x".to_string(),
        })
        .unwrap();
        bytes[0] = b'X';
        assert!(decode(&bytes).is_err());
    }

    #[test]
    fn decode_rejects_unsupported_version() {
        let mut bytes = encode(&Frame::Error {
            request_id: 0,
            message: "x".to_string(),
        })
        .unwrap();
        bytes[4] = 99;
        assert!(decode(&bytes).is_err());
    }

    #[test]
    fn decode_rejects_unknown_msg_type() {
        let mut bytes = encode(&Frame::Error {
            request_id: 0,
            message: "x".to_string(),
        })
        .unwrap();
        bytes[5] = 200;
        assert!(decode(&bytes).is_err());
    }

    #[test]
    fn decode_rejects_payload_len_mismatch() {
        let mut bytes = encode(&Frame::Error {
            request_id: 0,
            message: "hello".to_string(),
        })
        .unwrap();
        // Claim a bigger payload than what's actually present.
        let declared = u32::to_be_bytes(999);
        bytes[12..16].copy_from_slice(&declared);
        assert!(decode(&bytes).is_err());
    }

    #[test]
    fn decode_rejects_truncated_infer_request_crop_bytes() {
        let crops = vec![RawCrop {
            center: (0, 0),
            bytes: vec![9u8; 96 * 96 * 3],
        }];
        let frame = Frame::InferRequest {
            request_id: 1,
            frame_w: 100,
            frame_h: 100,
            crop_size: 96,
            crops,
        };
        let mut bytes = encode(&frame).unwrap();
        // Truncate the tail (drop the last 10 bytes of crop pixel data) but
        // leave payload_len as originally declared -- decode must catch the
        // resulting length mismatch, not read out of bounds.
        let truncated_len = bytes.len() - 10;
        bytes.truncate(truncated_len);
        assert!(decode(&bytes).is_err());
    }

    #[test]
    fn decode_rejects_trailing_bytes_after_a_valid_message() {
        let mut bytes = encode(&Frame::Error {
            request_id: 0,
            message: "x".to_string(),
        })
        .unwrap();
        bytes.push(0xFF);
        let payload_len = (bytes.len() - HEADER_LEN) as u32;
        bytes[12..16].copy_from_slice(&payload_len.to_be_bytes());
        assert!(decode(&bytes).is_err());
    }
}
