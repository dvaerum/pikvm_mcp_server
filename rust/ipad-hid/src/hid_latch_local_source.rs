//! LOCAL sample-source for the HID-latch monitor — the appliance-native read.
//!
//! Faithful port of `src/pikvm/hid-latch-local-source.ts`.
//!
//! Runs ON the pikvm-nixos appliance as a systemd service (no Mac/SSH/key/
//! sops): it reads local sysfs directly and hands the classifier a
//! composite `healthy` boolean. Two silicon-measured constraints from
//! it-03400 shape it:
//!
//! 1. COMPOSITE HEALTH keyed on `/sys/class/udc/<udc>/function`, NOT
//!    configfs. `/sys/class/udc/<udc>/state` is BLIND to a full gadget
//!    teardown — it reads `not attached` whether the gadget is
//!    bound-but-idle OR fully unbound (the #48 class: kvmd-otg never
//!    started, gadget dir never created). `function` is non-empty exactly
//!    when a gadget is bound, so `healthy = BOUND (function non-empty) AND
//!    state ∈ acceptable`. Keying on function (not configfs) is
//!    deliberate: the #48 gadget dir is ENOENT, and reading configfs there
//!    would error → the naive path would report the MOST-dead box as
//!    merely "unreachable" (a vacuous source_error). configfs is
//!    corroboration ONLY, for the `detail` string; its absence never
//!    produces a source_error. A genuine source_error is `/sys` itself
//!    unreadable.
//!
//! 2. REENUM is BOOT-SCOPED ONLY. The appliance has no RTC → pre-NTP
//!    kernel timestamps are months stale until sync → `journalctl --since`
//!    SILENTLY under-counts, pushing thrashing→latched (wrong rung). So
//!    the count is `journalctl -k -b` (this boot) with NO time window;
//!    windowing is the classifier's delta-between-samples job. The
//!    structure is FIXED (only the grep PATTERN is configurable) so
//!    `--since` can't be reintroduced by config.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::hid_latch_runner::{SampleSource, SourceReading};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub const DEFAULT_REENUM_PATTERN: &str = "bound driver configfs-gadget";
pub const DEFAULT_GADGET: &str = "kvmd";
/// Both `configured` (active) and `not attached` (bound-but-nothing-plugged) are fine when bound.
pub fn default_acceptable_states() -> Vec<String> {
    vec!["configured".to_string(), "not attached".to_string()]
}

/// Injectable local reads, so the composite + traps are unit-tested without real sysfs.
pub struct LocalLatchDeps {
    /// Read a file's text; errors on missing/unreadable (ENOENT etc.).
    pub read_file: Arc<dyn Fn(String) -> BoxFuture<'static, anyhow::Result<String>> + Send + Sync>,
    /// List a directory; errors if unreadable.
    pub list_dir:
        Arc<dyn Fn(String) -> BoxFuture<'static, anyhow::Result<Vec<String>>> + Send + Sync>,
    /// Count `journalctl -k -b` kernel lines containing `pattern` (boot-scoped, no --since).
    pub reenum_count: Arc<dyn Fn(String) -> BoxFuture<'static, anyhow::Result<i64>> + Send + Sync>,
}

#[derive(Default)]
pub struct LocalLatchSourceConfig {
    /// UDC name; default = first entry of `/sys/class/udc` (one on rpi4/zero2w, matches hid-recover.sh).
    pub udc: Option<String>,
    /// configfs gadget name for corroboration/detail; default `kvmd`.
    pub gadget: Option<String>,
    /// Fixed-structure grep pattern (env `PIKVM_LATCH_REENUM_PATTERN`); default the gadget bind line.
    pub reenum_pattern: Option<String>,
    /// UDC states that are acceptable WHEN BOUND (bound-ness is the real gate); default both idle+active.
    pub acceptable_states: Option<Vec<String>>,
    pub deps: Option<LocalLatchDeps>,
}

fn default_deps() -> LocalLatchDeps {
    LocalLatchDeps {
        read_file: Arc::new(|p: String| {
            Box::pin(async move { Ok(tokio::fs::read_to_string(p).await?) })
        }),
        list_dir: Arc::new(|p: String| {
            Box::pin(async move {
                let mut entries = Vec::new();
                let mut rd = tokio::fs::read_dir(p).await?;
                while let Some(e) = rd.next_entry().await? {
                    entries.push(e.file_name().to_string_lossy().to_string());
                }
                Ok(entries)
            })
        }),
        reenum_count: Arc::new(|pattern: String| {
            Box::pin(async move {
                // Boot-scoped ONLY (`-b`), no `--since` — count matching lines ourselves.
                let out = tokio::process::Command::new("journalctl")
                    .args(["-k", "-b", "--no-pager"])
                    .output()
                    .await?;
                let stdout = String::from_utf8_lossy(&out.stdout);
                Ok(stdout.lines().filter(|l| l.contains(&pattern)).count() as i64)
            })
        }),
    }
}

pub fn make_local_latch_source(cfg: LocalLatchSourceConfig) -> SampleSource {
    let deps = cfg.deps.unwrap_or_else(default_deps);
    let gadget = cfg.gadget.unwrap_or_else(|| DEFAULT_GADGET.to_string());
    let pattern = cfg
        .reenum_pattern
        .unwrap_or_else(|| DEFAULT_REENUM_PATTERN.to_string());
    let acceptable = cfg
        .acceptable_states
        .unwrap_or_else(default_acceptable_states);
    let configfs_udc_path = format!("/sys/kernel/config/usb_gadget/{gadget}/UDC");

    let resolved_udc: Arc<std::sync::Mutex<Option<String>>> =
        Arc::new(std::sync::Mutex::new(cfg.udc));
    let last_raw_reenum: Arc<std::sync::Mutex<i64>> = Arc::new(std::sync::Mutex::new(0));

    Arc::new(move || -> BoxFuture<'static, SourceReading> {
        let deps_read_file = deps.read_file.clone();
        let deps_list_dir = deps.list_dir.clone();
        let deps_reenum_count = deps.reenum_count.clone();
        let pattern = pattern.clone();
        let acceptable = acceptable.clone();
        let configfs_udc_path = configfs_udc_path.clone();
        let resolved_udc = resolved_udc.clone();
        let last_raw_reenum = last_raw_reenum.clone();

        Box::pin(async move {
            // Resolve the UDC once (one per board). list_dir failing/empty ⇒ /sys is gone = source_error.
            let udc = {
                let existing = resolved_udc.lock().unwrap().clone();
                match existing {
                    Some(u) => u,
                    None => {
                        let entries = match deps_list_dir("/sys/class/udc".to_string()).await {
                            Ok(e) => e,
                            Err(e) => {
                                return SourceReading::Err {
                                    error: format!("/sys/class/udc unreadable: {e}"),
                                }
                            }
                        };
                        if entries.is_empty() {
                            return SourceReading::Err {
                                error: "/sys/class/udc is empty (no UDC)".to_string(),
                            };
                        }
                        let first = entries[0].clone();
                        *resolved_udc.lock().unwrap() = Some(first.clone());
                        first
                    }
                }
            };

            // function + state are the primary signals; a read fault here = genuine source_error.
            let function_val = match deps_read_file(format!("/sys/class/udc/{udc}/function")).await
            {
                Ok(v) => v.trim().to_string(),
                Err(e) => {
                    return SourceReading::Err {
                        error: format!("/sys/class/udc/{udc} read failed: {e}"),
                    }
                }
            };
            let state = match deps_read_file(format!("/sys/class/udc/{udc}/state")).await {
                Ok(v) => v.trim().to_string(),
                Err(e) => {
                    return SourceReading::Err {
                        error: format!("/sys/class/udc/{udc} read failed: {e}"),
                    }
                }
            };
            let bound = !function_val.is_empty();

            // configfs = corroboration ONLY (for `detail`); ENOENT is the #48 case ⇒ BROKEN, NEVER source_error.
            let gadget_dir_absent = deps_read_file(configfs_udc_path).await.is_err();

            // reenum: best-effort; a read miss reuses the last value (never drops the latch signal).
            if let Ok(count) = deps_reenum_count(pattern).await {
                *last_raw_reenum.lock().unwrap() = count;
            }
            let raw_reenum = *last_raw_reenum.lock().unwrap();

            // boot_id (reboot→unreliable guard); best-effort.
            let boot_id = deps_read_file("/proc/sys/kernel/random/boot_id".to_string())
                .await
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            let healthy = bound && acceptable.contains(&state);
            let detail = if !bound {
                if gadget_dir_absent {
                    "unbound (#48: no gadget dir)".to_string()
                } else {
                    "unbound (gadget torn down)".to_string()
                }
            } else if state == "configured" {
                "configured".to_string()
            } else {
                format!("{state} (bound)")
            };

            SourceReading::Ok {
                healthy,
                raw_reenum,
                boot_id,
                detail: Some(detail),
                bound: Some(bound),
                state: Some(state),
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct FakeFs {
        files: HashMap<String, String>,
        dirs: HashMap<String, Vec<String>>,
    }

    fn fake_deps(fs: Arc<Mutex<FakeFs>>, reenum: i64) -> LocalLatchDeps {
        let fs_read = fs.clone();
        let fs_list = fs.clone();
        LocalLatchDeps {
            read_file: Arc::new(move |p: String| {
                let fs = fs_read.clone();
                Box::pin(async move {
                    fs.lock()
                        .unwrap()
                        .files
                        .get(&p)
                        .cloned()
                        .ok_or_else(|| anyhow::anyhow!("ENOENT: {p}"))
                })
            }),
            list_dir: Arc::new(move |p: String| {
                let fs = fs_list.clone();
                Box::pin(async move {
                    fs.lock()
                        .unwrap()
                        .dirs
                        .get(&p)
                        .cloned()
                        .ok_or_else(|| anyhow::anyhow!("ENOENT: {p}"))
                })
            }),
            reenum_count: Arc::new(move |_pattern: String| Box::pin(async move { Ok(reenum) })),
        }
    }

    fn bound_healthy_fs() -> FakeFs {
        let mut files = HashMap::new();
        files.insert(
            "/sys/class/udc/fe980000.usb/function".to_string(),
            "kvmd\n".to_string(),
        );
        files.insert(
            "/sys/class/udc/fe980000.usb/state".to_string(),
            "configured\n".to_string(),
        );
        files.insert(
            "/sys/kernel/config/usb_gadget/kvmd/UDC".to_string(),
            "fe980000.usb\n".to_string(),
        );
        files.insert(
            "/proc/sys/kernel/random/boot_id".to_string(),
            "boot-a\n".to_string(),
        );
        let mut dirs = HashMap::new();
        dirs.insert(
            "/sys/class/udc".to_string(),
            vec!["fe980000.usb".to_string()],
        );
        FakeFs { files, dirs }
    }

    #[tokio::test]
    async fn read_reports_healthy_when_bound_and_state_acceptable() {
        let fs = Arc::new(Mutex::new(bound_healthy_fs()));
        let source = make_local_latch_source(LocalLatchSourceConfig {
            deps: Some(fake_deps(fs, 3)),
            ..Default::default()
        });
        let reading = source().await;
        match reading {
            SourceReading::Ok {
                healthy,
                bound,
                state,
                raw_reenum,
                boot_id,
                detail,
                ..
            } => {
                assert!(healthy);
                assert_eq!(bound, Some(true));
                assert_eq!(state, Some("configured".to_string()));
                assert_eq!(raw_reenum, 3);
                assert_eq!(boot_id, Some("boot-a".to_string()));
                assert_eq!(detail, Some("configured".to_string()));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_the_48_case_unbound_no_gadget_dir_is_healthy_false_not_source_error() {
        let mut files = HashMap::new();
        files.insert(
            "/sys/class/udc/fe980000.usb/function".to_string(),
            "\n".to_string(),
        ); // empty = unbound
        files.insert(
            "/sys/class/udc/fe980000.usb/state".to_string(),
            "not attached\n".to_string(),
        );
        // NO configfs gadget dir entry at all -> ENOENT via fake -> gadget_dir_absent=true.
        let mut dirs = HashMap::new();
        dirs.insert(
            "/sys/class/udc".to_string(),
            vec!["fe980000.usb".to_string()],
        );
        let fs = Arc::new(Mutex::new(FakeFs { files, dirs }));
        let source = make_local_latch_source(LocalLatchSourceConfig {
            deps: Some(fake_deps(fs, 0)),
            ..Default::default()
        });
        let reading = source().await;
        match reading {
            SourceReading::Ok {
                healthy,
                bound,
                detail,
                ..
            } => {
                assert!(
                    !healthy,
                    "the #48 case must be healthy:false, not a source_error"
                );
                assert_eq!(bound, Some(false));
                assert_eq!(detail, Some("unbound (#48: no gadget dir)".to_string()));
            }
            other => panic!(
                "expected Ok (healthy:false), got {other:?} -- #48 must never be a source_error"
            ),
        }
    }

    #[tokio::test]
    async fn read_unbound_but_configfs_present_is_torn_down_not_48() {
        let mut files = HashMap::new();
        files.insert(
            "/sys/class/udc/fe980000.usb/function".to_string(),
            "".to_string(),
        );
        files.insert(
            "/sys/class/udc/fe980000.usb/state".to_string(),
            "not attached\n".to_string(),
        );
        files.insert(
            "/sys/kernel/config/usb_gadget/kvmd/UDC".to_string(),
            "fe980000.usb\n".to_string(),
        ); // present
        let mut dirs = HashMap::new();
        dirs.insert(
            "/sys/class/udc".to_string(),
            vec!["fe980000.usb".to_string()],
        );
        let fs = Arc::new(Mutex::new(FakeFs { files, dirs }));
        let source = make_local_latch_source(LocalLatchSourceConfig {
            deps: Some(fake_deps(fs, 0)),
            ..Default::default()
        });
        let reading = source().await;
        match reading {
            SourceReading::Ok { detail, .. } => {
                assert_eq!(detail, Some("unbound (gadget torn down)".to_string()))
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_bound_but_unacceptable_state_is_unhealthy() {
        let mut files = HashMap::new();
        files.insert(
            "/sys/class/udc/fe980000.usb/function".to_string(),
            "kvmd\n".to_string(),
        );
        files.insert(
            "/sys/class/udc/fe980000.usb/state".to_string(),
            "addressed\n".to_string(),
        ); // not acceptable
        let mut dirs = HashMap::new();
        dirs.insert(
            "/sys/class/udc".to_string(),
            vec!["fe980000.usb".to_string()],
        );
        let fs = Arc::new(Mutex::new(FakeFs { files, dirs }));
        let source = make_local_latch_source(LocalLatchSourceConfig {
            deps: Some(fake_deps(fs, 0)),
            ..Default::default()
        });
        let reading = source().await;
        match reading {
            SourceReading::Ok {
                healthy, detail, ..
            } => {
                assert!(!healthy);
                assert_eq!(detail, Some("addressed (bound)".to_string()));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_udc_class_unreadable_is_a_genuine_source_error() {
        let fs = Arc::new(Mutex::new(FakeFs {
            files: HashMap::new(),
            dirs: HashMap::new(),
        }));
        let source = make_local_latch_source(LocalLatchSourceConfig {
            deps: Some(fake_deps(fs, 0)),
            ..Default::default()
        });
        let reading = source().await;
        match reading {
            SourceReading::Err { error } => assert!(error.contains("/sys/class/udc unreadable")),
            other => panic!("expected Err, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_empty_udc_class_is_a_genuine_source_error() {
        let mut dirs = HashMap::new();
        dirs.insert("/sys/class/udc".to_string(), vec![]);
        let fs = Arc::new(Mutex::new(FakeFs {
            files: HashMap::new(),
            dirs,
        }));
        let source = make_local_latch_source(LocalLatchSourceConfig {
            deps: Some(fake_deps(fs, 0)),
            ..Default::default()
        });
        let reading = source().await;
        match reading {
            SourceReading::Err { error } => assert!(error.contains("no UDC")),
            other => panic!("expected Err, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_reenum_read_failure_reuses_the_last_value_not_zero() {
        let fs = Arc::new(Mutex::new(bound_healthy_fs()));
        let failing_reenum: Arc<
            dyn Fn(String) -> BoxFuture<'static, anyhow::Result<i64>> + Send + Sync,
        > = Arc::new(|_p: String| Box::pin(async { anyhow::bail!("journalctl unavailable") }));
        let mut deps = fake_deps(fs, 0);
        deps.reenum_count = failing_reenum;
        let source = make_local_latch_source(LocalLatchSourceConfig {
            deps: Some(deps),
            ..Default::default()
        });
        let reading = source().await;
        match reading {
            // First call: last_raw_reenum starts at 0, reenum read fails, stays 0 -- but the
            // point is it does NOT error the whole reading (best-effort).
            SourceReading::Ok { raw_reenum, .. } => assert_eq!(raw_reenum, 0),
            other => panic!("expected Ok even with a failing reenum read, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_boot_id_read_failure_degrades_to_none_not_source_error() {
        let mut files = HashMap::new();
        files.insert(
            "/sys/class/udc/fe980000.usb/function".to_string(),
            "kvmd\n".to_string(),
        );
        files.insert(
            "/sys/class/udc/fe980000.usb/state".to_string(),
            "configured\n".to_string(),
        );
        // No boot_id file at all.
        let mut dirs = HashMap::new();
        dirs.insert(
            "/sys/class/udc".to_string(),
            vec!["fe980000.usb".to_string()],
        );
        let fs = Arc::new(Mutex::new(FakeFs { files, dirs }));
        let source = make_local_latch_source(LocalLatchSourceConfig {
            deps: Some(fake_deps(fs, 0)),
            ..Default::default()
        });
        let reading = source().await;
        match reading {
            SourceReading::Ok {
                boot_id, healthy, ..
            } => {
                assert_eq!(boot_id, None);
                assert!(healthy);
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }
}
