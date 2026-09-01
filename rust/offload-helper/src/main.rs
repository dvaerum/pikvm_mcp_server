//! Entry point for `pikvm-offload-helper`
//! (docs/cursor-offload-inference-design.md, task_d06561d91f58): connects
//! OUT to a `pikvm-mcp-server`'s `/offload/ws`, authenticates with a
//! bearer token, and serves real cursor-detection cascade inference
//! requests using the SAME `pikvm-mcp-detection-vision` code the server
//! itself runs locally — remotely, on whatever machine this binary runs
//! on. Reconnects with backoff on any disconnect; never gives up.

mod backoff;
mod config;
mod connection;

use backoff::Backoff;
use ort::session::Session;
use sha2::Digest;

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let env: std::collections::HashMap<String, String> = std::env::vars().collect();

    let options = match config::parse_cli_options(&argv, &env, hostname) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    let model_path = options
        .model_path
        .map(std::path::PathBuf::from)
        .unwrap_or_else(pikvm_mcp_detection_vision::cursor_ml_detect::resolve_verifier_model);
    let model_bytes = std::fs::read(&model_path).unwrap_or_else(|e| {
        eprintln!(
            "Couldn't read the verifier model at {}: {e}",
            model_path.display()
        );
        std::process::exit(2);
    });
    let model_sha256: [u8; 32] = sha2::Sha256::digest(&model_bytes).into();
    eprintln!(
        "[offload-helper] loaded model from {} ({} bytes, sha256 {})",
        model_path.display(),
        model_bytes.len(),
        hex_encode(&model_sha256),
    );

    // Idempotent — matches detection-vision's own `with_verifier_session`
    // call site (`ort::init().commit()` only takes effect once per
    // process).
    ort::init().commit();
    let mut session = match Session::builder().and_then(|mut b| b.commit_from_file(&model_path)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "Failed to load the ONNX session from {}: {e}",
                model_path.display()
            );
            std::process::exit(2);
        }
    };

    eprintln!(
        "[offload-helper] label={:?} target={}",
        options.label, options.server_url
    );

    let mut backoff = Backoff::new();
    loop {
        let outcome = connection::run_one_session(
            &options.server_url,
            &options.token,
            &options.label,
            model_sha256,
            &mut session,
        )
        .await;
        if outcome == connection::SessionOutcome::WasConnected {
            backoff.on_success();
        }
        let delay = backoff.on_failure();
        eprintln!("[offload-helper] reconnecting in {delay:?}...");
        tokio::time::sleep(delay).await;
    }
}

fn hostname() -> Option<String> {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            // std::env::var("HOSTNAME") isn't reliably set on macOS shells —
            // fall back to the `hostname` command rather than pull in a
            // whole crate for a purely cosmetic label.
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|out| String::from_utf8(out.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
