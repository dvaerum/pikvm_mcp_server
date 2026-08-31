//! Native-macOS benchmark, for a fair Pi4-vs-Mac comparison
//! (task_f015816342cd, georg's direct question relayed by the manager).
//!
//! Measures the SAME quantities it-03400's real-Pi4 benchmark
//! (task_17eebaaa7160) reported: MCP server startup time, idle RSS, a
//! trivial round-trip tool call (`pikvm_version`), `pikvm_health_check`,
//! and cascade cursor-detection latency (no-hint vs a good hint).
//!
//! Server-level measurements reuse `move_to_click_at_mcp_smoke.rs`'s
//! established spawn-the-real-binary-over-real-stdio pattern (same
//! rationale: gate through the SAME entry point a user hits, not a
//! library-internal shortcut). Cascade timing calls `run_cascade`
//! directly against a real, ground-truth-labeled HDMI frame already used
//! by this session's own paired ground-truth bench
//! (data/openloopshape-real/) -- a real captured frame, not synthetic.
//!
//! Honesty note, stated up front rather than buried in a caveat later:
//! this is NOT byte-identical methodology to whatever ad hoc script
//! it-03400 ran on their own box (that script was never committed to the
//! repo) -- it targets the same quantities, the same real binary, the
//! same kind of real frame, built from the same rust-port/module-4-mover
//! branch, natively for this machine's own architecture. Differences in
//! exact frame/iteration count are called out in the report rather than
//! assumed away.
//!
//! Run (release build required first -- this does NOT build it for you):
//!   cargo build --release -p pikvm-mcp-server -p pikvm-mcp-detection-vision
//!   ORT_DYLIB_PATH=/path/to/libonnxruntime.dylib \
//!   PIKVM_HOST=... PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   PIKVM_PROXY=http://127.0.0.1:8888 \
//!   cargo run --release -p pikvm-mcp-server --example native_mac_vs_pi4_bench

use std::process::Stdio;
use std::time::{Duration, Instant};

use pikvm_mcp_detection_vision::cursor_detect::Point;
use pikvm_mcp_detection_vision::cursor_ml_detect::{resolve_verifier_model, run_cascade};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};

async fn send(stdin: &mut ChildStdin, value: &Value) {
    let mut line = serde_json::to_string(value).expect("request must serialize");
    line.push('\n');
    stdin.write_all(line.as_bytes()).await.expect("write");
}

async fn recv<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R, id: i64) -> Value {
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await.expect("read stdout");
        if n == 0 {
            panic!("child stdout closed before a response to id={id} arrived");
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if parsed.get("id").and_then(Value::as_i64) == Some(id) {
            return parsed;
        }
    }
}

async fn call_tool<R: tokio::io::AsyncBufRead + Unpin>(
    stdin: &mut ChildStdin,
    stdout: &mut R,
    id: i64,
    name: &str,
    arguments: Value,
) -> Duration {
    let start = Instant::now();
    send(
        stdin,
        &json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": name, "arguments": arguments}}),
    )
    .await;
    let response = recv(stdout, id).await;
    let elapsed = start.elapsed();
    if let Some(error) = response.get("error") {
        eprintln!("WARNING ({name}): JSON-RPC error (still timed): {error}");
    }
    elapsed
}

fn resolve_release_bin() -> std::path::PathBuf {
    let own_exe = std::env::current_exe().expect("current_exe");
    let profile_dir = own_exe
        .parent()
        .and_then(|p| p.parent())
        .expect("example binary should be two levels under target/release/");
    let bin = profile_dir.join("pikvm-mcp-server");
    assert!(
        bin.exists(),
        "expected the real release server binary at {bin:?} -- build it first with \
         `cargo build --release -p pikvm-mcp-server`"
    );
    bin
}

/// `ps -o rss=` requires an entitlement this sandboxed environment does
/// not have ("ps: rss: requires entitlement", confirmed directly, not
/// assumed) -- getrusage(RUSAGE_CHILDREN) after a plain SIGTERM+wait
/// would need restructuring the spawn flow above, so idle RSS is
/// measured externally instead via `/usr/bin/time -l` wrapping the same
/// binary directly (not through `timeout`, which was confirmed to
/// measure the WRONG process -- the interposed wrapper, not the actual
/// server) with a real initialize handshake sent over a FIFO, then a
/// direct SIGTERM to the resolved server PID. See this file's own run
/// log / the accompanying report for the real recipe and numbers -- this
/// function is intentionally NOT relied on; kept only as a documented
/// dead end so the next person doesn't reach for `ps` first and lose
/// time on the same wall this session already hit.
#[allow(dead_code)]
fn read_rss_kb(pid: u32) -> Option<u64> {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u64>()
        .ok()
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    values[values.len() / 2]
}

#[tokio::main]
async fn main() {
    println!("=== native_mac_vs_pi4_bench ===");
    println!("arch: {}", std::env::consts::ARCH);
    println!("os: {}", std::env::consts::OS);

    // --- 1. Server startup + idle RSS + trivial round-trip + health_check ---
    let bin = resolve_release_bin();
    println!("\n=== server binary: {bin:?} ===");

    let spawn_start = Instant::now();
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(["--transport", "stdio", "--target", "ipad"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let mut child: Child = cmd.spawn().expect("spawn the real server binary");
    let pid = child.id().expect("child pid");
    let mut stdin = child.stdin.take().expect("stdin piped");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout piped"));

    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "native_mac_vs_pi4_bench", "version": "0"}}
        }),
    )
    .await;
    let init = recv(&mut stdout, 1).await;
    let startup = spawn_start.elapsed();
    if init.get("error").is_some() {
        eprintln!("FAILED: initialize errored: {init}");
        let _ = child.kill().await;
        std::process::exit(1);
    }
    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    )
    .await;
    println!("startup (spawn -> initialize response): {startup:?}");

    // Idle RSS: `ps -o rss=` requires an entitlement this sandboxed
    // environment doesn't have (confirmed directly) -- measure it
    // externally instead, see this file's own `read_rss_kb` doc comment
    // for the real `/usr/bin/time -l` recipe used to get the actual
    // number reported alongside this harness's other output.
    let _ = pid; // kept for callers that DO have ps access
    tokio::time::sleep(Duration::from_millis(200)).await;
    println!("idle RSS: measured externally, see read_rss_kb's doc comment for the recipe");

    // Trivial round-trip: pikvm_version, median over 5 calls.
    let mut version_ms = Vec::new();
    for i in 0..5 {
        let d = call_tool(&mut stdin, &mut stdout, 10 + i, "pikvm_version", json!({})).await;
        version_ms.push(d.as_secs_f64() * 1000.0);
    }
    println!(
        "pikvm_version round-trip: median {:.2}ms across {:?}ms",
        median(&mut version_ms.clone()),
        version_ms
    );

    // pikvm_health_check: one real call (network-dependent, not iterated
    // the same way -- its own latency is dominated by real reachability
    // checks against pikvm01, not CPU, so a median-of-N here would mostly
    // measure network variance, not the binary's own speed).
    let health_d = call_tool(&mut stdin, &mut stdout, 20, "pikvm_health_check", json!({})).await;
    println!(
        "pikvm_health_check round-trip: {:.0}ms (network-dependent -- real reachability check against pikvm01, not a pure CPU measurement)",
        health_d.as_secs_f64() * 1000.0
    );

    let _ = child.kill().await;

    // --- 2. Cascade cursor-detection: no-hint vs good-hint, real frame ---
    println!("\n=== cascade cursor-detection (run_cascade, real ground-truth frame) ===");
    let model_path = resolve_verifier_model();
    println!("model: {model_path:?}");
    let repo_root = std::env::current_dir()
        .expect("cwd")
        .ancestors()
        .find(|p| p.join("data/openloopshape-real/manifest.jsonl").exists())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| {
            eprintln!("FAILED: could not find data/openloopshape-real/manifest.jsonl from cwd -- run from the repo root or a subdirectory of it");
            std::process::exit(1);
        });
    let frame_path = repo_root.join("data/openloopshape-real/frame-upper-right-01.jpg");
    let jpeg = std::fs::read(&frame_path).unwrap_or_else(|e| {
        eprintln!("FAILED: reading {frame_path:?}: {e}");
        std::process::exit(1);
    });
    // Ground truth for this exact file, from the manifest's own entry.
    let gt = Point {
        x: 1126.0,
        y: 298.0,
    };
    println!("frame: {frame_path:?} (1920x1080, gt=({},{}))", gt.x, gt.y);

    const ITERS: usize = 20;
    let model_str = model_path.to_string_lossy().to_string();

    // Warm-up (model load + first inference is not representative).
    let _ = run_cascade(&model_str, &jpeg, 1920, 1080, None, 32.0, 0.5, false);

    let mut no_hint_ms = Vec::new();
    for _ in 0..ITERS {
        let t0 = Instant::now();
        let r = run_cascade(&model_str, &jpeg, 1920, 1080, None, 32.0, 0.5, false);
        no_hint_ms.push(t0.elapsed().as_secs_f64() * 1000.0);
        if let Ok(None) = r {
            eprintln!("WARNING: no-hint cascade found nothing on this frame");
        }
    }
    let mut hint_ms = Vec::new();
    for _ in 0..ITERS {
        let t0 = Instant::now();
        let r = run_cascade(&model_str, &jpeg, 1920, 1080, Some(gt), 32.0, 0.5, false);
        hint_ms.push(t0.elapsed().as_secs_f64() * 1000.0);
        if let Ok(None) = r {
            eprintln!("WARNING: hint=gt cascade found nothing on this frame");
        }
    }

    println!(
        "no-hint (full scan): median {:.1}ms  min {:.1}ms  max {:.1}ms  (N={ITERS})",
        median(&mut no_hint_ms.clone()),
        no_hint_ms.iter().cloned().fold(f64::INFINITY, f64::min),
        no_hint_ms.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
    );
    println!(
        "hint=gt (narrow):    median {:.1}ms  min {:.1}ms  max {:.1}ms  (N={ITERS})",
        median(&mut hint_ms.clone()),
        hint_ms.iter().cloned().fold(f64::INFINITY, f64::min),
        hint_ms.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
    );

    println!("\n=== DONE ===");
}
