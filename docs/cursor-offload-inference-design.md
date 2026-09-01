# Remote cascade-inference offload to a general-purpose helper — design (task_d06561d91f58)

**STATUS: design reviewed (2026-09-01), implementation starting.** Full
design grilled with georg (relayed via manager, `task_d06561d91f58`) and
spot-checked against real code on `rust-port/module-4-mover` HEAD `97f6f10`
(includes PR #98's change-detection prefilter). Three real corrections were
folded in during drafting/review, not silently glossed over — see §4
(`block_in_place` gating, nixos-dev's review finding, confirmed against
source), §5, and §7.

## 0. Goal

A standalone native binary (`pikvm-offload-helper`) that runs on a
general-purpose computer — starting with the georgs-mac-mini node, measured
~29-32x faster than a real Pi4 on the raw cascade call, and up to 107.85x with
[the change-detection prefilter](cascade-change-detection-prefilter-design.md)
layered on top for the idle case (that doc's own real numbers). It connects
**out** to the Pi's `pikvm-mcp-server` over a new WebSocket endpoint,
authenticates with a dedicated bearer token, and processes cursor-detection
cascade batches remotely while connected. The Pi transparently falls back to
local processing whenever nothing is connected, a request times out, or a
response is malformed. Purely additive, off by default
(`PIKVM_OFFLOAD_ENABLED`).

## 1. Design decisions (already grilled with georg — not re-litigated here)

1. Target: any general-purpose computer; v1 build/validate against the Mac
   mini.
2. **Native binary, not WebAssembly.** WASM means rebuilding the whole AI
   pipeline on a separate runtime instead of reusing the real, proven
   `ort`-based `detection-vision` crate as-is — bigger, riskier, and a real
   speed tax for a feature whose entire point is speed.
3. Connection direction: helper connects **out** to the Pi (matches georg's
   firewall setup — the Pi is not reachable from the helper's side without
   this).
4. Lives **inside** `pikvm-mcp-server` as a new axum route, not a separate
   process. nginx/WAN exposure explicitly deferred — LAN-only v1.
5. Auth: a separate, dedicated bearer token — **never** the MCP server's main
   login credential.
6. Single active connection. A new connection replaces the old one. Any
   request in flight on the replaced connection falls back to local
   processing for that one request — never fails or hangs.
7. Per-request timeout even while connected: a slow reply falls back to local
   for that one request **without** dropping the connection.
8. Wire format: compact custom binary framing, not JSON — this is a
   per-detection-call hot path.
9. **v1 scope is exactly one call chain**: `run_cascade_inference_all` as
   invoked from `run_cascade_inference_prefiltered()` in
   `cursor_ml_detect.rs`. Three other real, low-volume call sites — verified
   live in source, not just asserted from the spec:
   - `mover/src/move_to/legacy_move.rs` (~line 1236, the V8-authoritative
     fallback consulted only when the cascade path found nothing)
   - `ipad-hid/src/hid_diagnosis.rs:63` (`default_cursor_locator`)
   - `ipad-hid/src/hid_recovery/behavioral.rs:61` (`make_behavioral_verifier`'s
     `locate` closure)

   stay local-only, unchanged, in v1. The third one is the load-bearing
   reason for the sync-confinement decision in §5.
10. Discoverability: both (a) a one-line hint on move/click/detect tool
    responses when offload is enabled but nothing is connected, and (b) a new
    `pikvm_offload_status` MCP tool reporting connection state and concrete
    setup instructions.
11. Off by default (`PIKVM_OFFLOAD_ENABLED=1` to opt in).
12. **Correctness before speed** — no speed number is trusted until: the
    helper is proven to run byte-identical inference code (structural, by
    construction — §4), the model identity is hash-checked at connect (§3),
    an offline round-trip codec test proves the wire protocol is lossless
    (§6), and a real Mac-mini + real-Pi4 parity run shows zero discrepancy
    across the same three scenarios (idle/moving/busy) the change-detection
    prefilter itself was gated on.

## 2. Wire protocol

Every WS binary frame carries a 16-byte header:

```
magic[4]    = "PKOF"
version:u8
msg_type:u8   1=Hello, 2=HelloAck, 3=InferRequest, 4=InferResponse, 5=Error
flags:u8
_pad:u8
request_id:u32
payload_len:u32
```

WebSocket's own Ping/Pong covers liveness — no app-level heartbeat needed.

- **Hello** (helper→server): `model_sha256[32]` + length-prefixed UTF-8
  label. Auth already happened at HTTP-upgrade time (bearer token header);
  this only proves *model* identity.
- **HelloAck** (server→helper): `accepted:u8` + reason string (populated only
  on rejection, e.g. model-hash mismatch). Connection is closed after a
  rejection.
- **InferRequest** (server→helper): `frame_w/h:u32`, `crop_size:u32`,
  `crop_count:u32`, then per-crop `cx,cy:i64` + raw `crop_size²×3` RGB bytes
  (unnormalized — the same bytes `crop_cache::extract_crop_bytes` already
  produces today, see §5).
- **InferResponse** (helper→server): `crop_count:u32` (must match the
  request; a mismatch is a protocol error — log it, fall back to local for
  that request, but **keep the connection alive**) + per-crop `x,y:i64`,
  `presence,heatmap_peak:f32`, in the same order as the request.
- **Error** (either direction): length-prefixed UTF-8 message.

`rust/offload-protocol/src/lib.rs`:
```rust
pub enum Frame {
    Hello { model_sha256: [u8; 32], label: String },
    HelloAck { accepted: bool, reason: String },
    InferRequest { frame_w: u32, frame_h: u32, crop_size: u32, crops: Vec<RawCrop> },
    InferResponse { results: Vec<CascadeResult> },
    Error { message: String },
}
pub fn encode(frame: &Frame) -> Vec<u8>;
pub fn decode(bytes: &[u8]) -> anyhow::Result<Frame>;
```

## 3. New crates

- **`rust/offload-protocol`** (`pikvm-mcp-offload-protocol`): the shared wire
  codec, depended on by both sides. Depends on
  `pikvm-mcp-detection-vision` directly so it reuses the real `CascadeResult`
  / `RawCrop` types — no duplicated type definitions to drift out of sync.
- **`rust/offload-helper`** (`pikvm-offload-helper`, binary): depends on
  `pikvm-mcp-foundation` (reuse `resolve_secret()` for token loading — see
  §7's correction on what's actually reusable from `foundation::auth`),
  `pikvm-mcp-detection-vision` (the real inference code, unmodified), and
  `pikvm-mcp-offload-protocol`.

Both added to `rust/Cargo.toml`'s `[workspace] members` (currently:
`detection-vision`, `foundation`, `cursor-belief`, `kvmd-client`, `mover`,
`ipad-hid`, `ipad-primitives`, `pikvm-mcp-server` — verified, neither new crate
is in that list yet).

## 4. `detection-vision` changes

- Add `pub struct RawCrop { pub center: (i64, i64), pub bytes: Vec<u8> }`
  next to `CascadeResult` (`cursor_ml_detect.rs:210`).
- Refactor `run_cascade_inference_all` (`cursor_ml_detect.rs:321`, verified
  present) to extract crops, then delegate to a new
  `run_cascade_inference_all_from_raw_crops(session, crops: &[RawCrop])`.
  This is the **one shared function** both the local path and the offload
  helper call — normalization/decode is byte-identical by construction,
  which is what makes the structural half of the correctness-parity proof
  (§6.1) actually true rather than asserted.
- Promote `crop_cache::extract_crop_bytes` (`crop_cache.rs:73`, currently a
  bare private `fn`, verified) to `pub(crate)` — visibility only, no logic
  change.
- New `rust/detection-vision/src/offload.rs`: a process-wide
  `OFFLOAD_CLIENT: OnceLock<Mutex<Option<OffloadInferenceFn>>>` singleton —
  same shape as the existing `VERIFIER_SESSION`/`REGION_CACHE` statics
  (`cursor_ml_detect.rs:220,223`, both verified present).
  `OffloadInferenceFn = Arc<dyn Fn(u32, u32, Arc<Vec<RawCrop>>) ->
  BoxFuture<'static, Option<Vec<CascadeResult>>> + Send + Sync>`. `None`
  means "no helper connected, or it timed out" — a normal, expected outcome
  that triggers local fallback, not an error.
- Rewrite `run_cascade_inference_prefiltered` (`cursor_ml_detect.rs:423`,
  verified present) to try the offload client first via a `try_offload()`
  sync→async bridge using `tokio::task::block_in_place`, **confined to this
  one function**.
- `detection-vision/Cargo.toml`: add `"rt-multi-thread"` to the `tokio`
  feature list — currently `["fs", "time"]` (verified exact string in
  source); `block_in_place` requires it.

### `block_in_place` must be gated behind a plain sync check — real risk, confirmed

Review finding (nixos-dev, confirmed independently against source): `try_offload()`
must do a **cheap, plain sync check first** — `OFFLOAD_CLIENT.get()...is_some()`
— and only call `block_in_place` when that's true. It must **not** wrap the
whole check-then-maybe-call sequence inside `block_in_place` unconditionally.

`block_in_place` requires an enclosing multi-threaded Tokio runtime to exist
at all — it panics otherwise. `find_cursor_by_v8_full_frame` and `run_cascade`
are genuinely sync functions called from real sync contexts, including plain
sync unit tests with no runtime present. Verified directly in source:
`find_cursor_by_v8_full_frame_returns_none_when_cascade_is_disabled` and
`find_cursor_by_v8_full_frame_real_model_runs_end_to_end`
(`cursor_ml_detect.rs:1109,1137`) are both bare `#[test]`, not
`#[tokio::test]` — zero tokio runtime present when they run today. Entering
`block_in_place` unconditionally on every call would either panic in these
(and any future) sync test contexts, or add always-on overhead even with
offload fully disabled — a real regression risk against the currently
100%-green suite, not a hypothetical one.

Required: an explicit new unit test proving `run_cascade_inference_prefiltered`
still runs correctly with **zero tokio runtime present** when offload is
disabled or nothing is connected — the concrete, checkable version of "the
fast path never touches `block_in_place`.

### Why the sync→async bridge stays confined to one function

`run_cascade` (`cursor_ml_detect.rs:461`) and `find_cursor_by_v8_full_frame`
must **not** become genuinely async. Verified directly in source:
`hid_recovery/behavioral.rs`'s `make_behavioral_verifier` builds its `locate`
closure as `|buffer: &[u8]| -> Option<(f64, f64)>` — a real, synchronous
closure signature, not `async`. Changing `find_cursor_by_v8_full_frame`'s own
signature to `async fn` would break that caller (and, per the spec, two
other direct call sites — `legacy_move.rs`, `hid_diagnosis.rs` — that stay
local-only in v1 precisely so this doesn't have to be re-litigated for them).
`block_in_place`, confined to `run_cascade_inference_prefiltered`, is what
lets the offload attempt be async internally (a WS round-trip needs to be)
without leaking `async` up through every caller of the sync detection API.

## 5. `pikvm-mcp-server` changes

- `Cargo.toml`: currently `axum = "0.8"` with no feature list (verified,
  `pikvm-mcp-server/Cargo.toml:24`) — change to
  `axum = { version = "0.8", features = ["ws"] }`; add `pikvm-mcp-offload-protocol`,
  `pikvm-offload-helper` is a separate binary crate so not a dep here; add
  `sha2 = "0.10"` for the model-hash check.
- New `rust/pikvm-mcp-server/src/offload/` module:
  - `registry.rs` — `OffloadState { token, model_hash, per_request_timeout,
    active: Mutex<Option<(generation, ActiveConnection)>> }`. `replace()`
    swaps in a new connection and **returns the old one** so its shutdown
    fires outside the lock (avoids holding the mutex across a
    potentially-slow close). `try_offload()` sends the request down an
    mpsc channel to the connection's own task and awaits a oneshot reply
    under `tokio::time::timeout` — a timeout and a dropped sender both
    naturally resolve to `None` (local fallback) via ordinary
    channel/`Drop` semantics, no special-cased error path needed.
  - `ws_handler.rs` — axum WS upgrade handler: bounded-timeout read of
    `Hello` → verify model hash → `HelloAck` → register (superseding any
    prior connection via `replace()`) → `tokio::select!` loop dispatching
    `InferRequest`s and matching `InferResponse`s by `request_id` → on any
    exit path, `clear_if_current(generation)` so a dead connection can't
    accidentally out-live itself in the registry.
  - `mod.rs` — `require_offload_auth` middleware doing a single bearer-token
    check, and `offload_router(state) -> Router`.
- `http_server.rs`: `run_http_server` (`:61`, verified present) gains
  `offload: Option<Arc<OffloadState>>`; `.merge(offload_router(...))` only
  when `Some` — mirrors the existing `.merge(mcp_router)` pattern
  (`:100`, verified) rather than inventing a new wiring style.
- `main.rs`: gate on `PIKVM_OFFLOAD_ENABLED=1`; if enabled,
  `resolve_offload_token` must resolve to something or the process exits
  with a clear startup error (never silently runs with an unauthenticated
  offload route).
- `foundation/src/config.rs`: new `resolve_offload_token()` — same
  `resolve_secret()`-based precedence as `resolve_http_auth` (`:107`,
  verified present alongside `resolve_secret` at `:61`), but a genuinely
  separate env-var namespace (`PIKVM_OFFLOAD_TOKEN*`) so the offload token
  can never accidentally resolve to the main HTTP auth secret.

### Discoverability

- `tools/offload_hint.rs`: `maybe_offload_hint(&SharedState) -> Option<String>`
  — appended to move/click/detect tool responses only when offload is
  enabled but nothing is connected. `SharedState` gains `offload:
  Option<Arc<OffloadState>>`.
- `tools/offload_status.rs`: new `pikvm_offload_status` tool, registered in
  `tools.rs` the same way `health_check::entries()` is (`tools.rs:151`,
  verified — `ToolEntry` struct at `:123`), reporting connection state plus
  concrete download/build/run instructions.

## 6. Correctness-parity proof (required before any speed claim)

1. **Structural**: local and offload both call the same
   `run_cascade_inference_all_from_raw_crops` (§4) — the normalization/decode
   path cannot silently diverge between the two, by construction.
2. **Connect-time model-hash check**: a mismatched `crop-heatmap.onnx` is
   refused outright at `Hello`/`HelloAck` time, before any inference request
   is ever sent.
3. New `rust/detection-vision/examples/offload_parity_smoke.rs` (mirrors the
   existing `cascade_hint_narrowing_smoke.rs` pattern): round-trips real
   captured frames through the real encode/decode codec via an in-process
   loopback stub, diffing every `CascadeResult` field for an exact match.
4. **Real hardware gate, required, blocking**: Mac mini + real Pi4, offload
   on vs. off, the same three scenarios the change-detection prefilter's own
   proof used — idle / moving / busy
   ([prior doc](cascade-change-detection-prefilter-design.md), real numbers:
   107.85x / 5x / 2.7x with correctness-first gating). Zero discrepancy
   required. Written up here, in the same closed-loop format as that doc,
   reporting **real end-to-end (network-included) speed** honestly — not the
   raw-inference-only number from the earlier native-Mac-vs-Pi4 benchmark,
   which did not include WS round-trip, encode/decode, or queuing cost.

## 7. Correction found during drafting: what's actually reusable from `foundation::auth`

The spec describes reusing "foundation::auth's existing constant-time
compare — promote from private to pub." Verified directly against source:
`header_matches` (`foundation/src/auth.rs:96`) is **already** `pub fn` inside
a `pub mod auth` (`foundation/src/lib.rs:11`) — nothing to promote there. The
function that's actually private is `safe_equal` (`auth.rs:63`, bare `fn`, no
`pub`) — the primitive `header_matches` itself calls internally to compare
username and password each in constant time. Two real options, not
pre-decided by the spec as written:

- Promote `safe_equal` itself to `pub(crate)` (visible within `foundation`)
  or `pub` (visible to `pikvm-mcp-server`), and have the offload auth
  middleware call it directly against the raw bearer token — simplest, and
  avoids constructing an `HttpAuth`-shaped username+password pair for what
  is really a single-token compare.
- Reuse `header_matches` as-is by treating the bearer token as if it were an
  `HttpAuth { username: "", password: token }` — reuses more existing code
  but is a slightly awkward fit for a bearer-token (not Basic-auth) scheme.

Recommend the first option (promote `safe_equal`) as the more honest fit for
a single-token bearer check; flagging here rather than silently picking one,
since the spec's own wording assumed a shape that isn't quite what's in
source.

## 8. Cross-platform build and distribution

No existing Rust CI in this repo at all (verified: no `.github/workflows/*.yml`
covering `rust/` today). New, **separate** `.github/workflows/offload-helper-release.yml`
— a GH Actions matrix:

| Target | Role |
|---|---|
| `aarch64-apple-darwin` | primary v1 target (georgs-mac-mini) |
| `x86_64-apple-darwin` | secondary Mac |
| `x86_64-unknown-linux-gnu` | generic Linux |
| `aarch64-unknown-linux-gnu` | generic Linux (arm) |
| `x86_64-pc-windows-msvc` | Windows |

Each build bundles the helper binary + `ml/crop-heatmap.onnx` + the matching
`onnxruntime` library for that target. **BSD is build-from-source only** — no
GH-hosted BSD runner exists; documented as a real, named limitation, not
silently dropped.

## 9. Phased rollout

1. `offload-protocol` crate + its own encode/decode round-trip tests.
2. `detection-vision` wiring (§4) — `RawCrop`, the shared
   `_from_raw_crops` function, the `OFFLOAD_CLIENT` singleton, the
   sync→async bridge confined to `run_cascade_inference_prefiltered`.
3. axum route + auth (§5, server side).
4. `pikvm-offload-helper` binary — reconnect logic modeled on
   `kvmd-client/src/streamer_keepalive/`'s own backoff shape (verified real
   constants: `RECONNECT_BASE_MS = 1000`, `RECONNECT_MAX_MS = 30_000`,
   `streamer_keepalive/types.rs:8-9`; `schedule_reconnect_task`,
   `keepalive.rs:139`, drives the actual reconnect-with-backoff loop this
   should mirror rather than reinvent).
5. Discoverability (`offload_hint`, `pikvm_offload_status`).
6. `offload_parity_smoke.rs` example (§6.3).
7. GH Actions release workflow (§8).
8. **Blocking**: real Pi4 + Mac-mini parity run (§6.4), written up, before
   this task is considered done.

### Named follow-ups (not blocking v1)

- nginx/WAN exposure — deferred by design (§1.4), LAN-only v1.
- Nix packaging of the helper binary.
- BSD prebuilt artifacts, if ever needed (source build documented as the v1
  answer, §8).
- Multiplexing more than one in-flight request — v1 assumes exactly one at a
  time, matching the existing `VERIFIER_SESSION` mutex's own serialization
  (`cursor_ml_detect.rs:220` — the local path already serializes on this
  mutex today, so v1's single-in-flight-request offload assumption doesn't
  regress anything relative to current behavior).

## 10. Sequencing

1. ~~This doc → review.~~ **Done.** nixos-dev reviewed; found one real,
   concrete implementation risk (the `block_in_place` gating in §4),
   confirmed independently against source and folded in. Design otherwise
   holds.
2. Implement per the phased rollout (§9), each phase independently testable
   before the next starts. **In progress.**
3. Correctness gate (§6.1-3) before any hardware timing is trusted.
4. Real Mac-mini + Pi4 parity run (§6.4) — needs real hardware access;
   per the manager's earlier instruction this routes to whoever has the
   live Pi4 (it-03400) once the helper binary and server route are both
   built and locally testable.
5. Report real, honest end-to-end numbers — positive or negative, same
   discipline as the change-detection prefilter's own §"Real result".
