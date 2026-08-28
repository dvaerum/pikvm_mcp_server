//! Persistence for the passive scale learner (task #41). Faithful port of
//! `src/pikvm/scale-persist.ts`.
//!
//! The learned per-axis scales survive restarts so a fresh process
//! warm-starts from the last-known-good value instead of re-learning (and
//! clicking uncorrected) each session. Writes are PERIODIC/debounced,
//! never per-move.
//!
//! Location (contract locked with pikvm-nixos 2026-07-31): the wrapper
//! sets `PIKVM_STATE_DIR` = the pikvm-mcp home-manager dataDir
//! (`~/.local/share/pikvm-mcp`) — the dir that already survives
//! darwin-rebuild switches and holds the production `data/`
//! (ballistics.json, cursor templates). We persist a SEPARATE file
//! `${PIKVM_STATE_DIR}/data/mover-scale.json` in that same surviving
//! `data/` dir — deliberately NOT merged into ballistics.json: that file
//! is the ballistics PROFILE and mixing in the unrelated curveScale
//! state risks breaking the profile loader for zero benefit. A sibling
//! file survives identically and orphans nothing. Dev fallback: cwd
//! (env unset ⇒ cwd).
//!
//! Everything here is FAIL-SAFE: an unreadable/corrupt file → start from
//! defaults; an unwritable dir → learn in-memory only. The learner never
//! blocks or throws on I/O.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::scale_learner::Axis;

const FILE: &str = "mover-scale.json";

// `rename_all = "camelCase"` on every multi-word-field struct below: this
// file may be read/written by either the TS or Rust implementation
// during the port's parallel-build period, and TS's `JSON.stringify`
// serializes its interface field names as-is (camelCase) — serde's
// default is the Rust field name verbatim (snake_case), which would
// silently desync the two implementations' on-disk format.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedProvenance {
    /// Detected iPad HDMI region at last write, for drift diagnosis;
    /// `None` if unknown.
    pub region: Option<Region>,
    /// Wall-clock ISO of the last write (caller supplies; this module
    /// never reads the clock itself).
    pub saved_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxisScale {
    pub applied: f64,
    pub last_update: Option<u64>,
}

/// Faithful shape of the TS `Record<Axis, {...}>` — a fixed 2-key struct
/// rather than a map, since `Axis` only ever has two valid values;
/// serializes to/from the SAME `{"x": ..., "y": ...}` JSON shape.
/// Deliberate, individually-justified deviation: external JSON identical,
/// internal Rust representation more precise (a map could hold an
/// invalid/missing key at compile time; this can't).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AxisScales {
    pub x: AxisScale,
    pub y: AxisScale,
}

impl std::ops::Index<Axis> for AxisScales {
    type Output = AxisScale;
    fn index(&self, axis: Axis) -> &AxisScale {
        match axis {
            Axis::X => &self.x,
            Axis::Y => &self.y,
        }
    }
}

impl std::ops::IndexMut<Axis> for AxisScales {
    fn index_mut(&mut self, axis: Axis) -> &mut AxisScale {
        match axis {
            Axis::X => &mut self.x,
            Axis::Y => &mut self.y,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PersistedState {
    pub version: PersistedVersion,
    // Only the learned scale + when it was learned. Counters are
    // session-scoped and NOT persisted (a cumulative `accepted` restored
    // alongside a session-zero `seen` made the status readout
    // inconsistent — georgs 2026-07-31).
    pub scales: AxisScales,
    pub provenance: PersistedProvenance,
}

/// Faithful port of TS's literal type `version: 1` — a single-value type
/// so `loadPersisted`'s "reject anything that isn't exactly version 1"
/// check is enforced by the type itself, not a runtime comparison. Wire
/// format is the JSON NUMBER `1` (matching the TS literal type exactly,
/// not the string `"1"` a derived unit-enum would produce) — this file
/// may be read/written by either implementation during the Rust port's
/// parallel-build period, so byte-for-byte JSON compatibility matters,
/// not just an internal implementation detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PersistedVersion;

impl Serialize for PersistedVersion {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(1)
    }
}

impl<'de> Deserialize<'de> for PersistedVersion {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let v = u8::deserialize(deserializer)?;
        if v == 1 {
            Ok(PersistedVersion)
        } else {
            Err(serde::de::Error::custom(format!(
                "unsupported PersistedState version: {v}"
            )))
        }
    }
}

/// The base dir the wrapper provides (`PIKVM_STATE_DIR`), else cwd for
/// dev. Read as an OPAQUE absolute path — do not assume XDG_STATE vs
/// XDG_DATA.
pub fn state_dir(env: &HashMap<String, String>) -> PathBuf {
    match env.get("PIKVM_STATE_DIR") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => std::env::current_dir().expect("current working directory should be readable"),
    }
}

/// The persisted file, a sibling of ballistics.json in the surviving
/// `data/` dir.
pub fn state_path(env: &HashMap<String, String>) -> PathBuf {
    state_dir(env).join("data").join(FILE)
}

/// Load the persisted state, or `None` if absent/unreadable/corrupt
/// (never fails the caller).
pub async fn load_persisted(env: &HashMap<String, String>) -> Option<PersistedState> {
    let raw = tokio::fs::read_to_string(state_path(env)).await.ok()?;
    serde_json::from_str::<PersistedState>(&raw).ok()
}

/// Write the state (creating the dir). Returns `true` on success,
/// `false` if unwritable — the caller then degrades to in-memory. Never
/// fails the caller.
pub async fn save_persisted(state: &PersistedState, env: &HashMap<String, String>) -> bool {
    async {
        let file = state_path(env);
        let dir = file.parent()?; // the surviving data/ dir
        tokio::fs::create_dir_all(dir).await.ok()?;
        // atomic-ish: write a temp then rename, so a crash mid-write
        // can't corrupt the file.
        let tmp = file.with_extension("json.tmp");
        let body = serde_json::to_string_pretty(state).ok()?;
        tokio::fs::write(&tmp, body).await.ok()?;
        tokio::fs::rename(&tmp, &file).await.ok()?;
        Some(())
    }
    .await
    .is_some()
}

/// Delete the persisted file (for reset). Absent file is success. Never
/// fails the caller.
pub async fn delete_persisted(env: &HashMap<String, String>) -> bool {
    match tokio::fs::remove_file(state_path(env)).await {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_state(y: f64) -> PersistedState {
        PersistedState {
            version: PersistedVersion,
            scales: AxisScales {
                x: AxisScale {
                    applied: 1.0,
                    last_update: Some(1),
                },
                y: AxisScale {
                    applied: y,
                    last_update: Some(2),
                },
            },
            provenance: PersistedProvenance {
                region: Some(Region { w: 680, h: 968 }),
                saved_at: Some("2026-07-31T00:00:00Z".to_string()),
            },
        }
    }

    fn env_for(dir: &std::path::Path) -> HashMap<String, String> {
        HashMap::from([(
            "PIKVM_STATE_DIR".to_string(),
            dir.to_string_lossy().to_string(),
        )])
    }

    mod location_contract {
        use super::*;

        #[test]
        fn reads_pikvm_state_dir_as_an_opaque_abs_path_else_cwd() {
            let env = HashMap::from([(
                "PIKVM_STATE_DIR".to_string(),
                "/Users/georg/.local/share/pikvm-mcp".to_string(),
            )]);
            assert_eq!(
                state_dir(&env),
                PathBuf::from("/Users/georg/.local/share/pikvm-mcp")
            );

            let empty = HashMap::new();
            assert_eq!(state_dir(&empty), std::env::current_dir().unwrap()); // dev fallback

            let env = HashMap::from([("PIKVM_STATE_DIR".to_string(), "/base".to_string())]);
            assert_eq!(
                state_path(&env),
                PathBuf::from("/base/data/mover-scale.json")
            ); // sibling of ballistics.json, NOT merged into it
        }
    }

    mod wire_format_matches_the_ts_implementation {
        use super::*;

        /// The two implementations may read/write the SAME file during
        /// the parallel-build period — pin the exact JSON key names
        /// (camelCase, matching `JSON.stringify` on the TS interface)
        /// rather than only round-tripping through this crate's own
        /// (de)serializer, which would stay green even if both sides
        /// silently renamed a key the same way.
        #[test]
        fn serializes_with_the_same_camel_case_keys_json_stringify_produces() {
            let json = serde_json::to_value(mk_state(1.031)).unwrap();
            assert_eq!(json["version"], serde_json::json!(1));
            assert_eq!(json["scales"]["x"]["applied"], serde_json::json!(1.0));
            assert_eq!(json["scales"]["y"]["lastUpdate"], serde_json::json!(2));
            assert_eq!(
                json["provenance"]["savedAt"],
                serde_json::json!("2026-07-31T00:00:00Z")
            );
            assert_eq!(json["provenance"]["region"]["w"], serde_json::json!(680));
            // The snake_case forms must NOT appear — that's exactly the
            // silent-desync bug this test exists to catch.
            assert!(json["scales"]["y"].get("last_update").is_none());
            assert!(json["provenance"].get("saved_at").is_none());
        }

        #[test]
        fn deserializes_a_literal_ts_shaped_json_document() {
            // A document shaped exactly like what src/pikvm/scale-persist.ts's
            // `savePersisted` would have written.
            let raw = r#"{
                "version": 1,
                "scales": {
                    "x": { "applied": 1.0, "lastUpdate": 1000 },
                    "y": { "applied": 1.031, "lastUpdate": 2000 }
                },
                "provenance": {
                    "region": { "w": 680, "h": 968 },
                    "savedAt": "2026-07-31T00:00:00Z"
                }
            }"#;
            let state: PersistedState = serde_json::from_str(raw).unwrap();
            assert!((state.scales.y.applied - 1.031).abs() < 1e-9);
            assert_eq!(state.scales.y.last_update, Some(2000));
            assert_eq!(
                state.provenance.saved_at.as_deref(),
                Some("2026-07-31T00:00:00Z")
            );
        }
    }

    mod round_trip_and_fail_safe {
        use super::*;

        #[tokio::test]
        async fn save_then_load_round_trips_the_state() {
            let dir = tempfile::tempdir().unwrap();
            let env = env_for(dir.path());
            assert!(save_persisted(&mk_state(1.031), &env).await);
            let loaded = load_persisted(&env).await.unwrap();
            assert!((loaded.scales.y.applied - 1.031).abs() < 1e-5);
            assert_eq!(loaded.provenance.region, Some(Region { w: 680, h: 968 }));
        }

        #[tokio::test]
        async fn load_returns_none_on_an_absent_or_corrupt_file_never_fails() {
            let dir = tempfile::tempdir().unwrap();
            let env = env_for(dir.path());
            assert!(load_persisted(&env).await.is_none()); // absent

            tokio::fs::create_dir_all(state_path(&env).parent().unwrap())
                .await
                .unwrap();
            tokio::fs::write(state_path(&env), "{ not json")
                .await
                .unwrap(); // corrupt
            assert!(load_persisted(&env).await.is_none());
        }

        #[tokio::test]
        async fn delete_removes_the_file_deleting_an_absent_file_is_still_success() {
            let dir = tempfile::tempdir().unwrap();
            let env = env_for(dir.path());
            save_persisted(&mk_state(1.0), &env).await;
            assert!(delete_persisted(&env).await);
            assert!(load_persisted(&env).await.is_none());
            assert!(delete_persisted(&env).await); // idempotent
        }

        #[tokio::test]
        async fn save_returns_false_when_the_dir_is_unwritable_caller_degrades_to_in_memory() {
            // Point at a path under a regular FILE so mkdir fails.
            let dir = tempfile::tempdir().unwrap();
            let blocker = dir.path().join("blocker");
            tokio::fs::write(&blocker, "x").await.unwrap();
            let env = env_for(&blocker.join("sub")); // under a file
            assert!(!save_persisted(&mk_state(1.0), &env).await);
        }
    }
}
