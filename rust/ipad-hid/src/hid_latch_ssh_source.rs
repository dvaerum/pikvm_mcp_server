//! SSH sample-source for the HID-latch monitor — the transport half of the runner.
//!
//! Faithful port of `src/pikvm/hid-latch-ssh-source.ts`.
//!
//! Reuses the SAME `ssh [user@]host <remote>` idiom (BatchMode,
//! ConnectTimeout, operator's own SSH config/agent, no embedded key
//! material) as the HID-recovery SSH trigger in `hid_recovery`, and the
//! same injectable exec closure so it is unit-testable without a real
//! network. Chosen over the HTTPS kvmd API because a headless launchd
//! agent has no macOS Local-Network privacy grant (the loopback-tinyproxy
//! the MCP relies on isn't guaranteed there) — reading the sysfs file over
//! SSH sidesteps that.
//!
//! Reads two things per poll: the UDC `state` (the latch ground truth) and
//! a RAW cumulative-since-boot re-enumeration count (the classification
//! signal, latch vs thrash). State parsing is STRICT — a missing state is
//! a source error — but the re-enum count is LENIENT: a failed count read
//! reuses the last known value rather than suppressing the latch alarm,
//! since only `state` decides whether we fire.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use regex::Regex;

use crate::hid_latch_monitor::UDC_UP;
use crate::hid_latch_runner::{SampleSource, SourceReading};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshLatchExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs one remote command via a spawned SSH BINARY. The `bin` is explicit
/// and TESTED (not folded into the args) because the transport only works
/// from a launchd context when the connection is made by Apple's SYSTEM
/// `/usr/bin/ssh` shelled out as a subprocess — a node in-process SSH
/// library would resurface the macOS Local-Network privacy block, and that
/// failure shows up ONLY on the Mac, never in the Linux test VM.
/// Injectable so parsing/idiom are unit-tested offline.
pub type SshLatchExec =
    Arc<dyn Fn(String, Vec<String>, u64) -> BoxFuture<'static, SshLatchExecResult> + Send + Sync>;

/// Counts enumeration ATTEMPTS (`new device is high-speed`), NOT completions
/// (`new address`) — measured/settled on pikvm01. This matters: a
/// hard-thrashing box repeatedly attempts enumeration and never COMPLETES,
/// so a completion count reads ~0 there and would misclassify a thrashing
/// (power-fault) box as `latched`, recommending a UDC-rebind when the real
/// fix is power/cable — the exact misdiagnosis the split exists to
/// prevent. Attempts stay high in that state, so they classify it
/// correctly.
///
/// Uses the PERSISTED kernel journal, not `dmesg`: on pikvm01 the dmesg
/// ring has ALREADY wrapped after 13 days of quiet operation (undercounting
/// today, before any storm). journald is much better but NOT unbounded here
/// — which is why the runner's monotonic-normalising backstop is
/// load-bearing, not belt-and-braces.
pub const DEFAULT_REENUM_COUNT_CMD: &str =
    "journalctl -k -b --no-pager 2>/dev/null | grep -c 'new device is high-speed'";

/// Default SSH binary — Apple's system ssh.
pub const DEFAULT_SSH_BINARY: &str = "/usr/bin/ssh";

pub struct SshLatchSourceConfig {
    /// `[user@]host`, from `PIKVM_HID_RECOVERY_SSH` (e.g. `root@pikvm01.bb.vcamp.dk`).
    pub host: String,
    /// Absolute path of the SSH binary to spawn. MUST be Apple's system
    /// `/usr/bin/ssh` on the Mac — pinned absolute (not PATH-resolved) on
    /// purpose.
    pub ssh_binary: Option<String>,
    /// Remote shell command that prints a CUMULATIVE-since-boot
    /// re-enumeration count on stdout.
    pub reenum_count_cmd: Option<String>,
    /// The UDC `state` that means HEALTHY for this target — the source
    /// computes the `healthy` boolean the (signal-agnostic) classifier
    /// consumes. Default `configured` (pikvm01, a live HID target).
    pub healthy_state: Option<String>,
    pub connect_timeout_s: Option<u32>,
    pub timeout_ms: Option<u64>,
    pub exec: Option<SshLatchExec>,
}

fn default_exec() -> SshLatchExec {
    Arc::new(|bin: String, args: Vec<String>, timeout_ms: u64| {
        Box::pin(async move {
            let fut = tokio::process::Command::new(&bin).args(&args).output();
            match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), fut).await {
                Ok(Ok(out)) => SshLatchExecResult {
                    code: out.status.code().unwrap_or(255),
                    stdout: String::from_utf8_lossy(&out.stdout).to_string(),
                    stderr: String::from_utf8_lossy(&out.stderr).to_string(),
                },
                Ok(Err(_)) => SshLatchExecResult {
                    code: 255,
                    stdout: String::new(),
                    stderr: String::new(),
                },
                Err(_) => SshLatchExecResult {
                    code: 255,
                    stdout: String::new(),
                    stderr: "ssh timed out".to_string(),
                },
            }
        })
    })
}

pub fn make_ssh_latch_source(cfg: SshLatchSourceConfig) -> anyhow::Result<SampleSource> {
    let host = cfg.host.trim().to_string();
    if host.is_empty() {
        anyhow::bail!("make_ssh_latch_source: host is required (PIKVM_HID_RECOVERY_SSH)");
    }
    let exec = cfg.exec.unwrap_or_else(default_exec);
    let ssh_binary = cfg
        .ssh_binary
        .unwrap_or_else(|| DEFAULT_SSH_BINARY.to_string());
    let reenum_cmd = cfg
        .reenum_count_cmd
        .unwrap_or_else(|| DEFAULT_REENUM_COUNT_CMD.to_string());
    let healthy_state = cfg.healthy_state.unwrap_or_else(|| UDC_UP.to_string());
    let connect_timeout_s = cfg.connect_timeout_s.unwrap_or(5);
    let timeout_ms = cfg.timeout_ms.unwrap_or(8_000);

    // Resolve the UDC on-host (nothing hardcoded); emit STATE=/REENUM=/BOOT= for
    // robust parsing. BOOT (boot_id) lets the monitor detect a mid-window reboot,
    // which resets the journal the re-enum count derives from and would otherwise
    // fake a `latched`.
    let remote = [
        "U=$(ls -1 /sys/class/udc 2>/dev/null | head -n1)".to_string(),
        "printf \"STATE=%s\\n\" \"$(cat /sys/class/udc/$U/state 2>/dev/null)\"".to_string(),
        format!("printf \"REENUM=%s\\n\" \"$({reenum_cmd})\""),
        "printf \"BOOT=%s\\n\" \"$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)\"".to_string(),
    ]
    .join("; ");
    // BatchMode → fail fast (never hang on a prompt) so unreachable is a reportable
    // state, not a silent hang. StrictHostKeyChecking=yes → known_hosts already has
    // pikvm01; a host-key surprise fails fast rather than trusting blindly.
    let args = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        format!("ConnectTimeout={connect_timeout_s}"),
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
        host,
        remote,
    ];

    let state_re = Regex::new(r"STATE=(.*)").unwrap();
    let reenum_re = Regex::new(r"REENUM=(\d+)").unwrap();
    let boot_re = Regex::new(r"BOOT=([0-9a-fA-F-]+)").unwrap();

    // Last successfully-read raw count, reused when a count read fails so a
    // transient dmesg hiccup neither suppresses the latch signal nor fakes a ring
    // wrap.
    let last_raw_reenum = Arc::new(std::sync::Mutex::new(0i64));

    Ok(Arc::new(move || -> BoxFuture<'static, SourceReading> {
        let exec = exec.clone();
        let ssh_binary = ssh_binary.clone();
        let args = args.clone();
        let healthy_state = healthy_state.clone();
        let state_re = state_re.clone();
        let reenum_re = reenum_re.clone();
        let boot_re = boot_re.clone();
        let last_raw_reenum = last_raw_reenum.clone();

        Box::pin(async move {
            let res = exec(ssh_binary, args, timeout_ms).await;
            if res.code != 0 {
                let raw = if !res.stderr.trim().is_empty() {
                    &res.stderr
                } else {
                    &res.stdout
                };
                let detail = raw.trim();
                let detail = if detail.is_empty() {
                    "unreachable".to_string()
                } else {
                    detail.chars().take(200).collect()
                };
                return SourceReading::Err {
                    error: format!("ssh rc={}: {}", res.code, detail),
                };
            }
            let state = match state_re.captures(&res.stdout) {
                Some(c) => c[1].trim().to_string(),
                None => String::new(),
            };
            if state.is_empty() {
                let truncated: String = res.stdout.trim().chars().take(200).collect();
                return SourceReading::Err {
                    error: format!("unparseable UDC state in remote output: {truncated}"),
                };
            }
            if let Some(c) = reenum_re.captures(&res.stdout) {
                if let Ok(n) = c[1].parse::<i64>() {
                    *last_raw_reenum.lock().unwrap() = n;
                }
            }
            // else: keep last_raw_reenum — a count-read miss must not drop the latch signal.
            let raw_reenum = *last_raw_reenum.lock().unwrap();
            let boot_id = boot_re.captures(&res.stdout).map(|c| c[1].to_string());
            // The source owns the health verdict; the classifier just consumes the boolean.
            let healthy = state == healthy_state;
            SourceReading::Ok {
                healthy,
                raw_reenum,
                boot_id,
                detail: Some(state.clone()),
                bound: None,
                state: Some(state),
            }
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exec_returning(result: SshLatchExecResult) -> SshLatchExec {
        Arc::new(move |_bin, _args, _timeout| {
            let result = result.clone();
            Box::pin(async move { result })
        })
    }

    #[test]
    fn make_ssh_latch_source_rejects_empty_host() {
        let err = make_ssh_latch_source(SshLatchSourceConfig {
            host: "   ".to_string(),
            ssh_binary: None,
            reenum_count_cmd: None,
            healthy_state: None,
            connect_timeout_s: None,
            timeout_ms: None,
            exec: None,
        })
        .err()
        .unwrap();
        assert!(err.to_string().contains("host is required"));
    }

    fn cfg(exec: SshLatchExec) -> SshLatchSourceConfig {
        SshLatchSourceConfig {
            host: "root@pikvm01".to_string(),
            ssh_binary: None,
            reenum_count_cmd: None,
            healthy_state: None,
            connect_timeout_s: None,
            timeout_ms: None,
            exec: Some(exec),
        }
    }

    #[tokio::test]
    async fn read_parses_a_healthy_state_and_reenum_and_boot_id() {
        let exec = exec_returning(SshLatchExecResult {
            code: 0,
            stdout: "STATE=configured\nREENUM=42\nBOOT=abc123\n".to_string(),
            stderr: String::new(),
        });
        let source = make_ssh_latch_source(cfg(exec)).unwrap();
        let reading = source().await;
        match reading {
            SourceReading::Ok {
                healthy,
                raw_reenum,
                boot_id,
                state,
                ..
            } => {
                assert!(healthy);
                assert_eq!(raw_reenum, 42);
                assert_eq!(boot_id, Some("abc123".to_string()));
                assert_eq!(state, Some("configured".to_string()));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_state_other_than_healthy_state_is_ok_but_unhealthy() {
        let exec = exec_returning(SshLatchExecResult {
            code: 0,
            stdout: "STATE=not attached\nREENUM=1\nBOOT=abc\n".to_string(),
            stderr: String::new(),
        });
        let source = make_ssh_latch_source(cfg(exec)).unwrap();
        let reading = source().await;
        match reading {
            SourceReading::Ok { healthy, state, .. } => {
                assert!(!healthy);
                assert_eq!(state, Some("not attached".to_string()));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_nonzero_exit_is_a_source_error() {
        let exec = exec_returning(SshLatchExecResult {
            code: 255,
            stdout: String::new(),
            stderr: "ssh: connect to host pikvm01 port 22: Connection refused".to_string(),
        });
        let source = make_ssh_latch_source(cfg(exec)).unwrap();
        let reading = source().await;
        match reading {
            SourceReading::Err { error } => {
                assert!(error.contains("ssh rc=255"));
                assert!(error.contains("Connection refused"));
            }
            other => panic!("expected Err, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_missing_state_is_unparseable_source_error() {
        let exec = exec_returning(SshLatchExecResult {
            code: 0,
            stdout: "REENUM=1\nBOOT=abc\n".to_string(), // no STATE= line
            stderr: String::new(),
        });
        let source = make_ssh_latch_source(cfg(exec)).unwrap();
        let reading = source().await;
        match reading {
            SourceReading::Err { error } => assert!(error.contains("unparseable UDC state")),
            other => panic!("expected Err, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_missing_reenum_reuses_last_value_not_zero() {
        // First call establishes REENUM=10; second call omits REENUM entirely.
        let call_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let exec: SshLatchExec = Arc::new(move |_bin, _args, _timeout| {
            let n = call_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async move {
                if n == 0 {
                    SshLatchExecResult {
                        code: 0,
                        stdout: "STATE=configured\nREENUM=10\nBOOT=abc\n".to_string(),
                        stderr: String::new(),
                    }
                } else {
                    SshLatchExecResult {
                        code: 0,
                        stdout: "STATE=configured\nBOOT=abc\n".to_string(),
                        stderr: String::new(),
                    }
                }
            })
        });
        let source = make_ssh_latch_source(cfg(exec)).unwrap();
        let first = source().await;
        assert!(matches!(first, SourceReading::Ok { raw_reenum: 10, .. }));
        let second = source().await;
        match second {
            SourceReading::Ok { raw_reenum, .. } => assert_eq!(
                raw_reenum, 10,
                "must reuse last known reenum, not drop to 0"
            ),
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_custom_healthy_state_is_honored() {
        let exec = exec_returning(SshLatchExecResult {
            code: 0,
            stdout: "STATE=addressed\nREENUM=0\nBOOT=abc\n".to_string(),
            stderr: String::new(),
        });
        let mut c = cfg(exec);
        c.healthy_state = Some("addressed".to_string());
        let source = make_ssh_latch_source(c).unwrap();
        let reading = source().await;
        match reading {
            SourceReading::Ok { healthy, .. } => assert!(healthy),
            other => panic!("expected Ok, got {other:?}"),
        }
    }
}
