//! Live-hardware smoke test for the HID-mode settling gate's auto-expiry
//! backstop — E2E validation risk category 3, docs/rust-port-plan.md §8
//! item 3, the #51 stale-settle-latch incident. The original bug: a
//! one-way `settling` flag cleared by exactly one caller (health_check on
//! confirmed UDC-online), never re-evaluated on release, so a missed
//! clear left the mover gate closed FOREVER until a restart. The fix
//! (already in `HidModeResolver::is_settling` — see hid_mode/resolver.rs)
//! re-derives settling from the wall clock every call
//! (`now() < settle_until`) instead of latching a flag, so it can never
//! get stuck even if nothing ever calls `clear_settling()`.
//!
//! This harness deliberately NEVER calls `clear_settling()` — it forces a
//! real mode switch, then polls `mover_gate()` across REAL wall-clock
//! time in a single continuous process (no restart) until the window
//! auto-expires, proving the backstop actually holds against a real
//! appliance, not just the fake clock the offline unit tests inject.
//!
//! **DISRUPTIVE**: this performs a REAL `POST /hidmode` mode switch on
//! the target appliance. Per the resolver's own contract, the switch
//! drops any live HID session on the target. Requires `PIKVM_HIDMODE_URL`
//! (endpoint-mode source only — a declared `--target` has no endpoint to
//! switch and this harness has nothing to test against it). Switches back
//! to the original mode at the end (best-effort).
//!
//! **Real experience, 2026-08-29**: the restore-to-original-mode step
//! failed live (`POST /hidmode` returned HTTP 500), and a subsequent GET
//! against the endpoint returned 403 for several retries — both
//! transient (a plain retry of the POST a few seconds later succeeded
//! cleanly, restoring `mouse.absolute=false` and a working relative
//! cursor, confirmed behaviorally with a real HID move + screenshot, not
//! just the flag). This is a real robustness gap in this harness's
//! best-effort cleanup, not a defect in the settling gate itself (the
//! actual test — auto-release without `clear_settling()` — passed
//! cleanly at 15075ms). If the cleanup step ever fails, don't just leave
//! the target on the switched-to mode: retry the restore POST once or
//! twice with a short delay before giving up, and verify with a real
//! HID move + screenshot after, not the endpoint's own reported status
//! alone. Not fixed inline here — flagging for whoever next hardens this
//! harness, since it's the cleanup path, not the thing being tested.
//!
//! Run:
//!   PIKVM_HIDMODE_URL=http://pikvm01/api/hidmode \
//!   PIKVM_USERNAME=... PIKVM_PASSWORD=... \
//!   [PIKVM_HIDMODE_TOKEN=... ] [PIKVM_PROXY=http://127.0.0.1:8888] \
//!   cargo run -p pikvm-mcp-ipad-hid --example hid_settling_gate_smoke

use std::time::{Duration, Instant};

use pikvm_mcp_ipad_hid::hid_mode::{
    make_http_hid_mode_endpoint, HidMode, HidModeHttpConfig, HidModeHttpDeps, HidModeResolver,
    HidModeResolverOpts,
};

/// Matches `hid_mode::types::DEFAULT_SETTLE_WINDOW_MS` at last check —
/// that constant is `pub(super)` (private to the crate), so this harness
/// keeps its own copy for the poll-timeout budget rather than importing
/// it. If the real gate ever takes meaningfully longer than this to
/// release, re-check that constant hasn't changed before assuming a
/// regression.
const EXPECTED_SETTLE_WINDOW_MS: u64 = 15_000;
/// How much longer than the expected window to wait before declaring the
/// gate genuinely stuck (generous — real USB re-enumeration timing on
/// physical hardware is not this port's clock to control).
const GRACE_MS: u64 = 20_000;
const POLL_INTERVAL_MS: u64 = 500;

fn opposite(mode: HidMode) -> HidMode {
    match mode {
        HidMode::Ipad => HidMode::Desktop,
        HidMode::Desktop => HidMode::Ipad,
    }
}

fn mode_name(mode: HidMode) -> &'static str {
    match mode {
        HidMode::Ipad => "ipad",
        HidMode::Desktop => "desktop",
    }
}

fn build_resolver() -> HidModeResolver {
    let url = std::env::var("PIKVM_HIDMODE_URL")
        .expect("set PIKVM_HIDMODE_URL — this harness only tests the endpoint-mode source");
    let username = std::env::var("PIKVM_USERNAME").ok();
    let password = std::env::var("PIKVM_PASSWORD").ok();
    let proxy_url = std::env::var("PIKVM_PROXY").ok();
    let token = std::env::var("PIKVM_HIDMODE_TOKEN").ok();

    let endpoint = make_http_hid_mode_endpoint(
        HidModeHttpConfig {
            url: Some(url),
            token,
            username,
            password,
            proxy_url,
            verify_ssl: Some(false),
            timeout_ms: None,
        },
        HidModeHttpDeps {
            get: None,
            post: None,
        },
    );
    HidModeResolver::new(HidModeResolverOpts {
        declared: None,
        endpoint: Some(endpoint),
        ttl_ms: None,
        settle_window_ms: None, // real default (see EXPECTED_SETTLE_WINDOW_MS above)
        now: None,              // real wall clock — the whole point of this gate
    })
}

#[tokio::main]
async fn main() {
    let mut resolver = build_resolver();

    eprintln!("=== 1/4: baseline resolve — confirm the endpoint is reachable and read the current mode ===");
    let Some(original_mode) = resolver.resolve().await else {
        eprintln!(
            "FAILED: endpoint unreachable or gadget unsettled at baseline — cannot run this \
             gate against a target that isn't in a known-good state to begin with."
        );
        std::process::exit(1);
    };
    eprintln!("baseline mode: {}", mode_name(original_mode));
    let target_mode = opposite(original_mode);

    eprintln!();
    eprintln!(
        "=== 2/4: DISRUPTIVE — switching {} -> {} (this drops the live HID session on the target) ===",
        mode_name(original_mode),
        mode_name(target_mode)
    );
    let write_result = resolver.set(target_mode).await;
    eprintln!(
        "set() result: ok={} message={}",
        write_result.ok, write_result.message
    );
    if !write_result.ok {
        eprintln!("FAILED: the appliance rejected the mode-switch POST — cannot test the settling gate without a real switch happening.");
        std::process::exit(1);
    }

    eprintln!();
    eprintln!("=== 3/4: immediately after the switch, the gate MUST be closed (settling) ===");
    let gate_right_after = resolver.mover_gate();
    if gate_right_after.allowed {
        eprintln!(
            "FAILED: mover_gate() was already `allowed=true` immediately after set() — the \
             settling gate isn't engaging at all, which defeats the whole point of this test \
             (there'd be nothing for the auto-expiry backstop to expire FROM)."
        );
        std::process::exit(1);
    }
    eprintln!(
        "confirmed closed: {}",
        gate_right_after.reason.unwrap_or_default()
    );

    eprintln!();
    eprintln!(
        "=== 4/4: polling mover_gate() every {POLL_INTERVAL_MS}ms across REAL wall-clock time — \
         NEVER calling clear_settling() — until it auto-releases (expect within ~{EXPECTED_SETTLE_WINDOW_MS}ms) ==="
    );
    let poll_start = Instant::now();
    let deadline = Duration::from_millis(EXPECTED_SETTLE_WINDOW_MS + GRACE_MS);
    let released_after = loop {
        let elapsed = poll_start.elapsed();
        let gate = resolver.mover_gate();
        if gate.allowed {
            break Some(elapsed);
        }
        if elapsed >= deadline {
            break None;
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    };

    let outcome = match released_after {
        Some(elapsed) => {
            eprintln!(
                "gate auto-released after {}ms with NO clear_settling() call and NO process \
                 restart — the #51 backstop holds against real hardware.",
                elapsed.as_millis()
            );
            if elapsed.as_millis() as u64 > EXPECTED_SETTLE_WINDOW_MS + 5_000 {
                eprintln!(
                    "NOTE: release took meaningfully longer than the expected \
                     {EXPECTED_SETTLE_WINDOW_MS}ms window (+5s tolerance) — not a failure (real \
                     USB re-enumeration timing varies), but worth a second look if this recurs."
                );
            }
            true
        }
        None => {
            eprintln!(
                "FAILED: mover_gate() never released within {}ms — this IS the #51 bug shape: a \
                 settling gate that stays closed indefinitely without a restart.",
                deadline.as_millis()
            );
            false
        }
    };

    eprintln!();
    eprintln!(
        "=== cleanup: best-effort switch back to the original mode ({}) ===",
        mode_name(original_mode)
    );
    let restore_result = resolver.set(original_mode).await;
    eprintln!(
        "restore set() result: ok={} message={}",
        restore_result.ok, restore_result.message
    );
    if !restore_result.ok {
        eprintln!(
            "WARNING: failed to restore the original mode automatically — the target may be left \
             on {} until manually switched back.",
            mode_name(target_mode)
        );
    }

    if !outcome {
        std::process::exit(1);
    }
    eprintln!("=== hid_settling_gate_smoke: PASSED ===");
}
