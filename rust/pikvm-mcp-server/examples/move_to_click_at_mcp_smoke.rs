//! Live-hardware smoke test for `pikvm_mouse_move_to`/`pikvm_mouse_click_at`
//! through the REAL MCP entry point — flagged by the manager for the E2E
//! validation pass (docs/rust-port-plan.md §8): the underlying
//! `move_to_pixel`/`click_at` orchestration being hardware-gated (e.g.
//! `curve_mover_smoke.rs`) does NOT prove the tool-registration/arg-
//! parsing/transport layer above it is wired correctly — a caller only
//! ever reaches these functions through `tools/call`, never by importing
//! the Rust function directly. Same "gate through the SAME entry point a
//! user hits" rule this project applies everywhere else.
//!
//! This spawns the REAL `pikvm-mcp-server` binary as a child process over
//! its real stdio JSON-RPC transport (no mocking, no rmcp client SDK
//! dependency — hand-rolled newline-delimited JSON-RPC, since adding
//! rmcp's `transport-child-process` feature would pull in a new
//! network-fetched dependency this offline-only porting environment
//! can't resolve; raw JSON-RPC over the real stdio pipe is at least as
//! faithful a test of "the real transport", not less), sends a real
//! `initialize` handshake, then a real `tools/call` for
//! `pikvm_mouse_move_to` (always) and `pikvm_mouse_click_at` (only with
//! `--click`, since clicking has real side effects on whatever the
//! target pixel actually is).
//!
//! **DISRUPTIVE with `--click`**: clicks a real point on the real target.
//! Without `--click` (default), this only MOVES the cursor — landing on
//! an icon is harmless since nothing is tapped, same safety framing
//! `curve_mover_smoke.rs` uses.
//!
//! Run:
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 ORT_DYLIB_PATH=... \
//!   cargo run -p pikvm-mcp-server --example move_to_click_at_mcp_smoke -- \
//!     --target ipad <target_x> <target_y> [--click]

use std::process::Stdio;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};

/// Send one JSON-RPC request/notification line to the child's stdin. The
/// real stdio transport (`rmcp::transport::stdio`) frames messages as
/// newline-delimited JSON — confirmed against the real running binary
/// earlier this port (see this crate's own git history), not assumed.
async fn send(stdin: &mut ChildStdin, value: &Value) {
    let mut line = serde_json::to_string(value).expect("request must serialize");
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .expect("write to child stdin");
}

/// Read stdout lines until one parses as JSON carrying the given request
/// `id` (skips any lines that aren't valid JSON-RPC responses — e.g. blank
/// keep-alive lines some transports emit). Exits the process if the
/// child's stdout closes before a matching response ever arrives.
async fn recv<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R, id: i64, label: &str) -> Value {
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .await
            .unwrap_or_else(|e| panic!("FAILED ({label}): reading child stdout errored: {e}"));
        if n == 0 {
            eprintln!("FAILED ({label}): child stdout closed before a response to id={id} arrived");
            std::process::exit(1);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
            continue; // not JSON — some transports interleave non-JSON diagnostic lines
        };
        if parsed.get("id").and_then(Value::as_i64) == Some(id) {
            return parsed;
        }
        // A response to a DIFFERENT id (or a server->client request/
        // notification) — not what we're waiting for, keep reading.
    }
}

/// Call one MCP tool by name over the real transport; exits the process
/// with a clear FAILED line on any transport error, JSON-RPC error, or
/// `isError: true` tool result — mirroring the established
/// `curve_mover_smoke.rs`/`slam_and_cascade_smoke.rs` convention of an
/// unambiguous nonzero exit on any gate failure.
async fn call_tool<R: tokio::io::AsyncBufRead + Unpin>(
    stdin: &mut ChildStdin,
    stdout: &mut R,
    id: i64,
    name: &str,
    arguments: Value,
) -> Value {
    eprintln!("--> tools/call {name} {arguments}");
    send(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments}
        }),
    )
    .await;
    let response = recv(stdout, id, name).await;
    eprintln!("<-- {response}");
    if let Some(error) = response.get("error") {
        eprintln!("FAILED ({name}): JSON-RPC error: {error}");
        std::process::exit(1);
    }
    let result = response.get("result").unwrap_or_else(|| {
        panic!("FAILED ({name}): response had neither 'result' nor 'error': {response}")
    });
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        eprintln!("FAILED ({name}): tool reported isError=true — see content above");
        std::process::exit(1);
    }
    result.clone()
}

async fn spawn_server(target: &str) -> (Child, ChildStdin, BufReader<tokio::process::ChildStdout>) {
    // `CARGO_BIN_EXE_<name>` is only set by Cargo for `tests/*.rs`
    // integration-test binaries via `cargo test` — NOT for
    // `examples/*.rs` via `cargo run` (confirmed against the real `cargo
    // run --example` invocation, not assumed). Resolve the sibling
    // `pikvm-mcp-server` binary from this example's OWN executable path
    // instead: `cargo run --example` places both under the same
    // `target/<profile>/` directory (`examples/<name>` and the bin
    // itself), same bundled/cwd-relative resolution idiom this port
    // already uses for `resolve_skills_dir`/`resolve_verifier_model`.
    let own_exe = std::env::current_exe().expect("current_exe");
    let profile_dir = own_exe
        .parent() // target/<profile>/examples/
        .and_then(|p| p.parent()) // target/<profile>/
        .expect("example binary should be two levels under target/<profile>/");
    let bin_name = if cfg!(windows) {
        "pikvm-mcp-server.exe"
    } else {
        "pikvm-mcp-server"
    };
    let bin = profile_dir.join(bin_name);
    assert!(
        bin.exists(),
        "expected the real server binary at {bin:?} — build it first with \
         `cargo build -p pikvm-mcp-server` (this example doesn't build it for you, matching \
         curve_mover_smoke.rs's own assumption that the workspace is already built)"
    );
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["--transport", "stdio", "--target", target])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit()) // surface the server's own diagnostic banner/warnings directly
        .kill_on_drop(true);
    let mut child = cmd.spawn().expect("spawn the real pikvm-mcp-server binary");
    let stdin = child.stdin.take().expect("child stdin was piped");
    let stdout = BufReader::new(child.stdout.take().expect("child stdout was piped"));
    (child, stdin, stdout)
}

#[tokio::main]
async fn main() {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let mut target = "ipad".to_string();
    let mut also_click = false;
    let mut positional: Vec<String> = Vec::new();
    let mut i = 0;
    while i < raw_args.len() {
        match raw_args[i].as_str() {
            "--target" => {
                target = raw_args
                    .get(i + 1)
                    .cloned()
                    .expect("--target requires a value (ipad or desktop)");
                i += 2;
            }
            "--click" => {
                also_click = true;
                i += 1;
            }
            other => {
                positional.push(other.to_string());
                i += 1;
            }
        }
    }
    let (target_x, target_y) = if positional.len() >= 2 {
        (
            positional[0]
                .parse::<f64>()
                .expect("target_x must be a number"),
            positional[1]
                .parse::<f64>()
                .expect("target_y must be a number"),
        )
    } else {
        eprintln!(
            "no target given, defaulting to (950, 400) — pass target_x target_y to aim elsewhere"
        );
        (950.0, 400.0)
    };

    eprintln!("=== move_to_click_at_mcp_smoke: spawning the real server (--target {target}) ===");
    let (mut child, mut stdin, mut stdout) = spawn_server(&target).await;

    eprintln!(
        "=== 1/{}: real MCP handshake over the real stdio transport ===",
        if also_click { 3 } else { 2 }
    );
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "move_to_click_at_mcp_smoke", "version": "0"}
            }
        }),
    )
    .await;
    let init = recv(&mut stdout, 1, "initialize").await;
    eprintln!("<-- {init}");
    if init.get("error").is_some() {
        eprintln!("FAILED: initialize errored — the transport/tool-registration layer isn't even coming up: {init}");
        let _ = child.kill().await;
        std::process::exit(1);
    }
    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    )
    .await;

    eprintln!();
    eprintln!(
        "=== 2/{}: real tools/call \"pikvm_mouse_move_to\" -> ({target_x}, {target_y}) ===",
        if also_click { 3 } else { 2 }
    );
    let move_result = call_tool(
        &mut stdin,
        &mut stdout,
        2,
        "pikvm_mouse_move_to",
        json!({"x": target_x, "y": target_y}),
    )
    .await;
    eprintln!("pikvm_mouse_move_to content: {}", move_result["content"]);

    if also_click {
        eprintln!();
        eprintln!("=== 3/3: DISRUPTIVE — real tools/call \"pikvm_mouse_click_at\" -> ({target_x}, {target_y}) ===");
        let click_result = call_tool(
            &mut stdin,
            &mut stdout,
            3,
            "pikvm_mouse_click_at",
            json!({"x": target_x, "y": target_y}),
        )
        .await;
        eprintln!("pikvm_mouse_click_at content: {}", click_result["content"]);
    }

    eprintln!();
    eprintln!("=== shutting down the child server ===");
    drop(stdin); // close stdin — the server's own real shutdown path
    let _ = child.kill().await;

    eprintln!(
        "=== move_to_click_at_mcp_smoke: PASSED (mechanically) — both tools returned isError=false \
         through the REAL tools/call transport path, proving the tool-registration/arg-parsing/\
         dispatch layer is wired correctly. Inspect the printed content above (and, for move_to, \
         curve_mover_smoke's own screenshot convention if you want visual confirmation of the \
         landing) before trusting the underlying accuracy claim — this harness proves WIRING, not \
         mover accuracy (that's curve_mover_smoke's/the N>=20 click-bench's job) ==="
    );
}
