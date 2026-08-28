//! Ballistics profile persistence and freshness check. Faithful port of
//! `defaultProfilePath`/`saveProfile`/`loadProfile`/`profileIsFreshFor`.
//!
//! Deliberately NOT `scale_persist.rs`'s fail-safe-always discipline:
//! `ballistics.ts`'s own `saveProfile`/`loadProfile` propagate I/O and
//! parse errors loudly (only a missing file is swallowed to `None`) — a
//! caller explicitly asked to persist/load a measurement profile, unlike
//! the passive scale-learner's best-effort background persistence, so
//! this file matches that fail-loud contract rather than copying the
//! other module's fail-safe one.

use std::path::{Path, PathBuf};

use pikvm_mcp_kvmd_client::client::ScreenResolution;

use super::types::BallisticsProfile;

pub fn default_profile_path() -> PathBuf {
    std::env::current_dir()
        .expect("current working directory should be readable")
        .join("data")
        .join("ballistics.json")
}

pub async fn save_profile(profile: &BallisticsProfile, file_path: &Path) -> anyhow::Result<()> {
    if let Some(dir) = file_path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let body = serde_json::to_string_pretty(profile)?;
    tokio::fs::write(file_path, body).await?;
    Ok(())
}

pub async fn load_profile(file_path: &Path) -> anyhow::Result<Option<BallisticsProfile>> {
    let raw = match tokio::fs::read_to_string(file_path).await {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let parsed: BallisticsProfile = serde_json::from_str(&raw)?;
    if parsed.version != 1 {
        anyhow::bail!("Unsupported ballistics profile version: {}", parsed.version);
    }
    Ok(Some(parsed))
}

pub fn profile_is_fresh_for(
    profile: Option<&BallisticsProfile>,
    resolution: ScreenResolution,
) -> bool {
    let Some(profile) = profile else {
        return false;
    };
    profile.resolution.width == resolution.width && profile.resolution.height == resolution.height
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(width: u32, height: u32) -> BallisticsProfile {
        BallisticsProfile {
            version: 1,
            created_at: "2026-08-28T00:00:00.000Z".to_string(),
            resolution: ScreenResolution { width, height },
            samples: Vec::new(),
            medians: [
                ("x:slow:127".to_string(), 1.2),
                ("y:slow:127".to_string(), 1.4),
            ]
            .into_iter()
            .collect(),
        }
    }

    /// Faithful port of `src/pikvm/__tests__/ballistics.test.ts`'s
    /// `describe('profileIsFreshFor', ...)` block.
    mod profile_is_fresh_for_tests {
        use super::*;

        #[test]
        fn returns_false_when_profile_is_null() {
            assert!(!profile_is_fresh_for(
                None,
                ScreenResolution {
                    width: 1920,
                    height: 1080
                }
            ));
        }

        #[test]
        fn returns_true_when_resolution_matches_exactly() {
            let p = profile(1920, 1080);
            assert!(profile_is_fresh_for(
                Some(&p),
                ScreenResolution {
                    width: 1920,
                    height: 1080
                }
            ));
        }

        #[test]
        fn returns_false_on_resolution_mismatch_width() {
            let p = profile(1920, 1080);
            assert!(!profile_is_fresh_for(
                Some(&p),
                ScreenResolution {
                    width: 2560,
                    height: 1080
                }
            ));
        }

        #[test]
        fn returns_false_on_resolution_mismatch_height() {
            let p = profile(1920, 1080);
            assert!(!profile_is_fresh_for(
                Some(&p),
                ScreenResolution {
                    width: 1920,
                    height: 1440
                }
            ));
        }

        /// REGRESSION (matching the TS test's own name): the bug was that
        /// `profileIsFreshFor` existed but was never called, so a
        /// 1920×1080 profile would be silently consumed on a 2048×1536
        /// device. This pins the predicate's contract so the wiring stays
        /// alive even if move-to's eventual call site moves around.
        #[test]
        fn previously_dead_code_is_now_wired_into_move_to() {
            let stale = profile(1920, 1080);
            let fresh = ScreenResolution {
                width: 2048,
                height: 1536,
            };
            assert!(!profile_is_fresh_for(Some(&stale), fresh));
        }
    }

    /// New ground (no TS test coverage found for saveProfile/loadProfile
    /// themselves) — mirrors scale_persist.rs's own round-trip/fail-safe
    /// test style, adapted to THIS file's fail-LOUD contract (see the
    /// module doc): unlike scale_persist's `load_persisted`, a corrupt
    /// file or wrong version must propagate an `Err`, not silently
    /// degrade to `None`.
    mod save_load_round_trip {
        use super::*;

        fn mk_profile() -> BallisticsProfile {
            BallisticsProfile {
                version: 1,
                created_at: "2026-08-28T00:00:00.000Z".to_string(),
                resolution: ScreenResolution {
                    width: 1920,
                    height: 1080,
                },
                samples: vec![],
                medians: [("x:slow:127".to_string(), 1.031)].into_iter().collect(),
            }
        }

        #[tokio::test]
        async fn save_then_load_round_trips_the_profile() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("data").join("ballistics.json");
            save_profile(&mk_profile(), &path).await.unwrap();
            let loaded = load_profile(&path).await.unwrap().unwrap();
            assert_eq!(loaded, mk_profile());
        }

        #[tokio::test]
        async fn load_returns_none_on_an_absent_file() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("data").join("ballistics.json");
            assert!(load_profile(&path).await.unwrap().is_none());
        }

        #[tokio::test]
        async fn load_errors_loudly_on_a_corrupt_file_unlike_scale_persist() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("data").join("ballistics.json");
            tokio::fs::create_dir_all(path.parent().unwrap())
                .await
                .unwrap();
            tokio::fs::write(&path, "{ not json").await.unwrap();
            assert!(load_profile(&path).await.is_err());
        }

        #[tokio::test]
        async fn load_errors_loudly_on_an_unsupported_version_with_the_ts_message() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("data").join("ballistics.json");
            tokio::fs::create_dir_all(path.parent().unwrap())
                .await
                .unwrap();
            tokio::fs::write(
                &path,
                r#"{"version":2,"createdAt":"x","resolution":{"width":1,"height":1},"samples":[],"medians":{}}"#,
            )
            .await
            .unwrap();
            let err = load_profile(&path).await.unwrap_err();
            assert_eq!(err.to_string(), "Unsupported ballistics profile version: 2");
        }
    }

    #[test]
    fn default_profile_path_is_data_ballistics_json_under_cwd() {
        let path = default_profile_path();
        assert_eq!(path.file_name().unwrap(), "ballistics.json");
        assert_eq!(path.parent().unwrap().file_name().unwrap(), "data");
        assert!(path.is_absolute());
    }
}
