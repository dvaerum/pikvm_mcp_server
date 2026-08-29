//! One-shot diagnostic: does get_tracked_cursor() succeed IMMEDIATELY
//! after the hello handshake (app still foreground), confirming whether
//! backgrounding the app (Cmd+H) is what kills the WS session. Not part
//! of the reviewed bench plan — an ad-hoc live diagnostic only.
use pikvm_mcp_mover::ipad_collector::wait_for_ipad_collector_session;
use std::time::Duration;

#[tokio::main]
async fn main() {
    eprintln!("waiting for iPadCollector session...");
    let session = wait_for_ipad_collector_session(8767, Duration::from_secs(60))
        .await
        .expect("session never connected");
    eprintln!(
        "connected: model={}, logical {}x{}",
        session.hello.model, session.hello.logical_w, session.hello.logical_h
    );
    eprintln!("calling get_cursor() IMMEDIATELY (app still foreground)...");
    match session.get_cursor().await {
        Ok(c) => eprintln!("SUCCESS: {c:?}"),
        Err(e) => eprintln!("FAILED: {e}"),
    }
}
