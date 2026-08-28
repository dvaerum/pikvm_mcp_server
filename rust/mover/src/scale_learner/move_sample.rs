//! `record_move_sample` + its `MoveLearnSample` input — the one real
//! call site both index.ts's move_to handler and click-at.ts's clickAt()
//! shared (F2, Round 2 Phase 2). Lives here rather than in `learner.rs`
//! since it's a free function taking a `&mut ScaleLearner`, not part of
//! the learner's own API surface — and it's a temporary home (see
//! `MoveLearnSample`'s own doc): both belong in `crate::move_to` once
//! that module lands, same pattern as `curve_mover`'s
//! `DEFAULT_CURVE_SCALE_Y` stub.

use super::learner::ScaleLearner;
use super::types::{Axis, SampleMeta};

/// The exact 5 fields `record_move_sample` needs — a faithful, complete
/// port of `move-to.ts`'s `MoveLearnSample` interface (not a partial
/// projection; that interface has no other fields). Lives here rather
/// than blocking on move-to.rs, same pattern as `curve_mover`'s
/// `DEFAULT_CURVE_SCALE_Y` stub — move to `crate::move_to` and re-export
/// once that module lands.
#[derive(Debug, Clone, Copy)]
pub struct MoveLearnSample {
    pub planned_x: f64,
    pub planned_y: f64,
    pub achieved_x: f64,
    pub achieved_y: f64,
    pub woken: bool,
}

/// F2 (Round 2 Phase 2): the one `record_move_sample` — previously
/// duplicated verbatim in index.ts's move_to handler and click-at.ts's
/// clickAt(), both reaching directly into the module-singleton
/// `scaleLearner`. Takes the learner as a param instead (not a
/// process-wide singleton — this port doesn't have one; the real MCP
/// server wiring in module 6 owns that shared-state question), so this
/// stays unit-testable without global state.
///
/// (#41) feeds a completed curve-one-shot's free first-shot sample to
/// the passive scale learner. The learner's own hygiene rejects a
/// faded-cursor-wake start or a forced click; its pre-filter + median
/// absorb the rest. No-op when the mover produced no sample (start or
/// first landing undetected → `learn_sample` is `None`).
pub fn record_move_sample(
    learner: &mut ScaleLearner,
    learn_sample: Option<MoveLearnSample>,
    applied_x: f64,
    applied_y: f64,
    forced: bool,
) {
    let Some(ls) = learn_sample else { return };
    let meta = SampleMeta {
        woken: ls.woken,
        forced,
        ..Default::default()
    };
    learner.record_sample(Axis::X, ls.planned_x, ls.achieved_x, applied_x, meta);
    learner.record_sample(Axis::Y, ls.planned_y, ls.achieved_y, applied_y, meta);
}
