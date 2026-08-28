# pikvm-mcp-server — Rust port (in progress)

Parallel Rust implementation of the TypeScript `pikvm-mcp-server`, per
`docs/adr/0002-rust-port-full-bigbang.md`. **Big-bang strategy**: build here
independently, validate with real hardware gates (see
`docs/rust-port-plan.md` §8), then cut over — the TypeScript implementation
in `../src` remains the single source of production behavioral truth until
this port earns its own hardware-verified confidence. Not performance-driven
(`docs/rust-port-plan.md` Part I) — preference/maintainability, per ADR-0002.

## Layout

A Cargo workspace, one crate per module from `docs/rust-port-plan.md` §7's
build sequence (each depends only on earlier modules):

| Crate | Module | Status |
|---|---|---|
| `foundation` | 1: config/settings/auth/session-auth/kvmd-auth/lock/util/version | ✅ complete, 61 tests |
| _(not yet started)_ | 2: kvmd transport client | — |
| _(not yet started)_ | 3: detection/vision | — |
| _(not yet started)_ | 4: mover/HID orchestration | — |
| _(not yet started)_ | 5: iPad-specific/HID recovery | — |
| _(not yet started)_ | 6: MCP protocol surface | — |

Real agent-mcp tasks track each module: task_39b946273448 (1) /
task_dbf947d5d878 (2) / task_72403c2d858c (3) / task_9bb80e84c948 (4) /
task_4719c8794fbd (5) / task_ead854232bc8 (6), all under task_63dd02e1bd7e.

## Discipline

- **Faithful port first.** Match the existing TypeScript behavior exactly —
  no design improvements folded in at the same time (that's a deliberate,
  separate follow-up later, per the manager's explicit instruction). Every
  module/function doc comment names the TS source file/symbol it ports.
- **TDD.** Every public function has tests before/alongside the
  implementation, mirroring the TS test's actual assertions where one
  exists — not just "does it compile."
- **Library-first** (`docs/rust-port-plan.md` §6): `rmcp` for the MCP wire
  protocol, `ort` for ONNX inference, `axum` for HTTP, `tokio-tungstenite`
  for WebSocket, `reqwest` for the kvmd REST client, `dotenvy` for `.env`.
  Hand-rolling only where no established crate fits — justified inline when
  that happens.
- **`cargo clippy --all-targets` and `cargo fmt` clean before every commit.**
- **Hardware gates, not just green tests**, for modules 3/4/5 (the
  historically-hardware-risk-heavy layers) — see
  `docs/rust-port-plan.md` §8 for the four named incidents (N1, F6/F8,
  #51's stale-settle-latch, PR93's cascade hints) this port must re-earn
  confidence against, the same discipline that caught them the first time
  in the TypeScript implementation.

## Building

```sh
cd rust
cargo test --workspace
cargo clippy --workspace --all-targets
cargo fmt --workspace -- --check
```

Requires a Rust toolchain (`rustup default stable` if none is configured).
