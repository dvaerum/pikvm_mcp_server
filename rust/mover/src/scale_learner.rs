//! Passive scale learner (task #41) — the per-axis curveScale correction
//! the mover's open-loop shot applies, learned passively from live
//! click-verify residuals. EXPERIMENTAL, off by default.
//!
//! Faithful port of `src/pikvm/scale-learner.ts`. Only [`Axis`] is ported
//! so far — [`crate::scale_persist`] (module 4's first increment) needs
//! it for `PersistedState`'s `scales` field. The learner's actual
//! gate/window/estimator logic lands in a later increment.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    X,
    Y,
}
