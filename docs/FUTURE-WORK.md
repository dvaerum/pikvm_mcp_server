# Future work / backlog

Deferred items — captured so they aren't lost. NOT scheduled. (GitHub issues are disabled
on the repo, so this file is the backlog.)

## Target localization — "tap UI elements by name" (GUI grounding)  [DEFERRED]
The next capability after the (solved) cursor detector + mover: figure out WHICH pixel a named
target is at ("tap Continue", "open Settings", "the + button") so the system acts on names, not
hand-picked coordinates. Vision-only (HDMI black-box; no accessibility tree from other apps).
- Stage 1 (OCR text) = DONE prototype: tools/ocr/ocr.swift (Apple Vision) + scratch/tap-by-text.ts;
  validated live (`tap-by-text "Display & Brightness"` localized + navigated, no coords).
- Stage 1.5 = app-icon label→icon offset (labels ~26px below icon).
- Stage 2 (icon-only: +, search, back) = the fork: OmniParser (robust but AGPL + 300MB + slow),
  vs a small custom detector (needs UI-element labels), vs classical CV+OCR, vs defer.
- First step when resumed: promote Stage 1 into a src/ module + tap-by-text command/nix app.
- Details/research: docs/target-localization-plan.md.

## openLoopShape detector — grey-background locate blind-spot  [OPEN, offline-diagnosable]
The `openLoopShape` fallback detector (`CursorLocator` profile `openLoopShape`, i.e.
`findCursorByMLMultiHint` → `findCursorByShape` dark/bright, exercised live via the
exported `tryOpenLoopShapeDetect`, `src/pikvm/move-to.ts`) under-locates on a solid-grey
scene: **~48% locate overall, 0% in the upper-right region, ~6 px accurate when it does
hit** (measured live on iPad by the @georgs-mac-mini worker, 2026-07-22). Accurate-on-hit
but low recall → a *detection-recall / coordinate-coverage* problem, not an accuracy one.
This is the canonical tracker for the finding (previously only in commit messages + agent
profiles).
- The shape/ML detectors are hint-anchored: shape uses `expectedNear: predicted` +
  `expectedNearRadius: 100`; ML uses `buildMLHints(predicted, …)`. So recall depends on
  both detector coordinate handling AND hint geometry near frame edges.
- The `upper-right` target is `(tight.x + 0.75·tight.w, tight.y + 0.25·tight.h)`
  (`benches/lib/groundtruth.ts` `standardTargets`).
- OFFLINE repro (no iPad): sweep the 180×180 cursor sprite (`ml/cursor-sprite.png`,
  label point = centre (90,90)) composited on a grey-0.55 frame across a position grid and
  run the pure detectors directly — `benches/bench-openloopshape-offline-sweep.ts`. Sweeping
  with a *perfect* hint isolates a genuine detector edge/coordinate blind-spot from an
  upstream hint-geometry cause.
- A fix's final sign-off must be routed to the iPad-equipped node for a ground-truth bench
  (`benches/bench-openloopshape-groundtruth.ts`).

**PINPOINT (2026-07-22, REAL pixels).** Ran the detection stages individually on 12 real
grey-0.55 captures (`data/openloopshape-real/`, 6 upper-right; `benches/analyze-openloopshape-real.ts`):
- cascade (`findCursorByV8FullFrame`) + ml-multihint locate the real cursor **100% at every
  target incl upper-right (6/6), residual 2–4 px**. Detection is NOT the failure.
- `findCursorByShape` (dark AND bright) returns **null on all 12** — it is not a working
  fallback on real grey; the path is cascade-only in practice.
- Therefore the live "~48% / 0% upper-right" is DOWNSTREAM of detection — the device-only
  **wiggle-verify gate** (`mlWiggleVerify` / `wiggleVerifyCandidate`, gated by
  `tautologyProxThreshold`) rejecting valid detections. Candidate fix: the full-frame cascade
  is hint-INDEPENDENT, so its detection can't be a hint-tautology — SKIP the wiggle-verify
  tautology guard for cascade-sourced fixes (let the accurate 2–4 px detection through).
  Wiggle-verify is device-only → the fix + sign-off must be validated live by the iPad node.
  UPDATE 2026-07-23: the wiggle-verify fix shipped (e3669a1, live 46%→100%).

**SHAPE FALLBACK IS DEAD + HARMFUL → RETIRE (2026-07-23).** Cross-background
characterization (`benches/bench-shape-vs-cascade-backgrounds.ts`: the real cursor sprite
composited at a grid over 16 backgrounds = solid grey + all 15 `data/bg-real` home screens,
192 frames; cascade vs `findCursorByShape` dark/bright per frame):
- cascade (`findCursorByV8FullFrame`) locates **100% on EVERY background** incl every busy
  home screen (192/192, zero misses).
- `findCursorByShape` **shape-ANY = 1%** (0% on 14/16 backgrounds); **RESCUE (cascade miss &
  shape hit) = 0/192** — it never once found the cursor where the cascade didn't; **MISFIRE
  (candidate >35 px from truth) = 27%** (up to 50% on books.jpg) — on busy backgrounds it
  emits FALSE candidates the wiggle-verify gate then has to reject (the same FP surface the
  tautology guard existed for).
- RECOMMENDATION: retire the shape fallback from the openLoopShape detection path
  (`cursor-locator.ts` `locateOpenLoopShape`, the dark/bright branch). It contributes nothing
  the cascade doesn't and only manufactures false candidates. Device-gated: needs @georgs live
  N≥80 (`bench-openloopshape-groundtruth.ts` — cascade-only should EQUAL cascade+shape) before
  merge. NOTE: `findCursorByShape`'s SEPARATE use in `move-to.ts wiggleVerifyCandidate` (post-
  wiggle motion check) is a different mechanism, NOT covered by this — do not remove that.

## Git history reclaim (167MB)  [DEFERRED]
The old cursor-v0..v12 model binaries are untracked now but still in .git history (~167MB).
Reclaiming needs a history rewrite (git filter-repo) — invasive (rewrites shared commits).
Only worth it if repo size matters.

## Data & model storage / reproducibility  [IN PROGRESS 2026-07-20]
How to store all created/collected data + trained models so we can (a) fully reproduce/retrain
from scratch AND (b) have models ready-to-go without rerunning the pipeline. See the design being
added to docs/ (data-and-model-storage plan).

## click-verify.ts orphaned predicates — kept, not dead code  [RESOLVED 2026-08-24; moved to click-verify-archive.ts 2026-08-26]
Phase 6 architecture-review audit: `isRateLimited`, `shouldFireDismissRecipe`,
`shouldFireSecondOpinion`, `shouldAdoptSecondOpinion`, `shouldEmitApproach`,
`isLockScreenRecoveryError`, `evaluatePreClickAgreement` (originally all
`src/pikvm/click-verify.ts`) have zero real callers anywhere in
`src/`/`benches/`/`scratch/` — only their own test files exercise them. Root cause:
PR #34 (`1b900df`, 2026-07-28, "remove tap-retry — single-attempt clicks") deleted
`clickAtWithRetry`, their only real caller, and its own commit message says they were
kept deliberately even then. The second-opinion pair briefly regained a caller
(`cursor-locator.ts`'s offline `'verify'` profile) before that too was deleted as dead
scaffolding in ADR 0003 (`docs/adr/0003-cursor-locator-is-the-front-door.md`).

**Decision: keep all seven.** Each is a pure, deterministic, well-tested predicate pinning
a specific real historical bug (see each function's own doc comment for its bug history —
`evaluatePreClickAgreement`'s is the densest in the file, narrating Phase 41→42→51→52→
PA19-c). Deleting them as "unused" would lose that record; if a future caller needs this
arbitration logic again, they're ready as-is.

**F13/N2 (Round 2 Phase 2c, 2026-08-26): moved to a new `src/pikvm/click-verify-archive.ts`.**
Rather than leave 7 zero-caller exports mixed into the active `click-verify.ts` module
(the file real production code imports from), split them into a dedicated archive file
with a group signpost explaining the "kept deliberately" decision — `click-verify.ts`
now contains only functions with real callers. Their 6 test files (the second-opinion
pair shares one file) moved alongside into `src/pikvm/__tests__/click-verify-archive/`,
import paths updated. No re-export back into `click-verify.ts` — nothing imports these
today.

**Also added, NOT part of the original 7 — flagged here explicitly since it wasn't
previously ruled on:** `clampPxPerMickeyRatio` (`click-verify.ts:49`) was found to be an
EIGHTH zero-caller orphan during this same sweep — same bar (zero real callers, only its
own test exercises it), but NOT orphaned by PR #34 (it was never wired to
`clickAtWithRetry` in the first place, per its own doc comment — a "sanity-clamp" helper
for a live px/mickey ratio that no caller ever fed it). Moved into the same
`click-verify-archive.ts` alongside the documented 7, its test file moved to the same
`__tests__/click-verify-archive/` directory. 7→8.

## isUdcUp — deleted, unlike the click-verify.ts group  [RESOLVED, 2026-08-25]
`isUdcUp` (`src/pikvm/hid-latch-monitor.ts`) — a trivial `state === UDC_UP` wrapper — had
zero real callers; its own sibling constant `UDC_UP` was already used directly by
`hid-latch-ssh-source.ts` instead of going through the wrapper. Unlike the click-verify.ts
group above, it carried no historical-bug narrative — its doc comment read as "convenience
predicate for state-based sources," i.e. written for an intended caller that ended up
inlining the comparison itself instead. Deleted (same bar as ADR 0003's `verify` profile:
confirmed zero real callers, no bug-history reason to keep), confirmed by the manager —
`hid-latch-monitor.test.ts`'s one internal use (a test-helper reenum counter) switched to
the equivalent inline `state !== UDC_UP`, and the dedicated `describe('isUdcUp...', ...)`
block was removed along with it.

## Stale scratch/benches scripts — broken since PR #34, not individually fixed  [TRACKED, 2026-08-25]
PR #34 (`1b900df`, 2026-07-28) deleted `clickAtWithRetry` and `defaultMaxRetriesFor` from
`click-verify.ts` (retry removed — clicks are single-attempt, see that commit's own
rationale). None of the production call sites broke (they'd already moved to `moveToPixel` +
inline click, later consolidated into `clickAt()` — Phase 4/F5, `click-at.ts`), but 28
one-off `scratch/`/`benches/` scripts that imported the deleted exports directly did, and
have sat broken since. Phase 6 architecture-review audit (2026-08-25) confirmed: none of
these 28 are wired into `flake.nix` `apps` or `package.json` scripts, so nothing a real user
runs is affected — this is backlog housekeeping, not a production gap.

Two flake-wired scripts that hit the SAME breakage (`nix run .#explore`, `nix run
.#live-bench` → `scratch/explore.ts`, `scratch/click-bench80-retry3.ts`) were fixed as part
of this same Phase 6 pass — ported to `clickAt()` from `src/pikvm/click-at.ts` with
single-attempt semantics (no retry loop reintroduced, matching PR #34's own rationale). Use
that pair as the reference pattern (`HidModeResolver({ declared: 'ipad' })` for a standalone
script's `HidPolicy`, `loadProfile('./data/ballistics.json')` for the `BallisticsProfile`,
`ClickAtOutcome`'s discriminated `kind` for result handling) if any of the 28 below are ever
needed again — port on demand, don't pre-fix speculatively.

The 28, left as-is (broken, not deleted — each still holds real bench methodology / trace
data worth keeping as reference even while non-runnable):
- `benches/`: bench-alpha-trace-books.ts, bench-approach-ab.ts, bench-clickable.ts,
  bench-click-extensive.ts, bench-click-production.ts, bench-clickretry.ts,
  bench-click-timing.ts, bench-files-only.ts, bench-ground-truth-clickflow.ts,
  bench-jitter-ab.ts, bench-ml-v0-vs-v1.ts, bench-ml-v1-vs-v4.ts, bench-ml-v5gate-vs-v1.ts,
  bench-toggle-pointer-animations.ts, bench-v10-live.ts, bench-v11-live.ts,
  bench-v8-calibrate-ab.ts.
- `scratch/`: _capture-settings-via-bench.ts, click-bench80.ts, _click-continue.ts,
  click-test-oneshot.ts, tap-by-text.ts, test-click-newest.ts,
  test-phase248-n20-with-blocklist.ts (also imports the now-nonexistent
  `src/pikvm/cursor-fp-blocklist.js`), test-phase305-slam-unstick.ts,
  test-phase307-bench-with-unlock.ts, test-v238-books-verify.ts, test-v241-settings-verify.ts,
  test-v241-short-bench.ts.

## measureCell pairing false-negative — spurious large-blob artifact  [OPEN, 2026-08-25]
During PR #78's (F1, slamToCorner/anchorCursor verifyMotion unification) live hardware
gate, georgs-mac-mini ran a short `measureBallistics` sweep (2 magnitudes × 2 reps) as
case (d). Traced each "mass rejected" result individually rather than taking the summary
at face value: two were genuine real hot-corner locks (screenshot-confirmed, correctly
rejected by the F1-consolidated slam-verification check — not a regression, the same
compounding-slam risk PR #62's gate hit months earlier). One intermediate cell and a final
minimal single-cell run both passed slam-verification CLEANLY (zero "not verified"
rejections) — proof the consolidated check accepts a real good landing, not just rejects
failures. That last cell then failed a **separate, unrelated** downstream check:
`measureCell`'s own cluster-pairing logic (`orderClustersByDirection` /
`PairSelectionOptions` in `ballistics.ts`, the `"no cluster pair aligned"` log line) — not
touched by PR #78's diff. georgs-mac-mini's read: a spurious large-blob detection artifact
in the diff, unrelated to the real (much smaller) cursor visible in the final screenshot,
prevented a valid before/after pair from being selected.

Not reproduced/investigated further yet — `orderClustersByDirection`'s existing
`cursorMaxPixels` filter (default 150px) should already exclude an oversized blob from the
candidate pool, so if the artifact still caused a mispairing it's either (a) under the
150px ceiling despite being much larger than the real cursor, or (b) the artifact excluded
a *different* valid candidate some other way. Whoever picks this up should start by
capturing the actual clusters (sizes + positions) from a repro run before theorizing
further — this entry only records what was observed live, not a diagnosis.

## iPad rig re-locking repeatedly during long back-to-back test sessions  [OPEN, 2026-08-26]
During PR #88's (F6, shrink `AnchorRequest`) live hardware gate, georgs-mac-mini's 4th
case (a short `measureBallistics` sweep, 2 magnitudes × 2 reps, exercising the
`recovery: 'inspect-only'` path) got 0/8 cells accepted — all 8 rejected. Rather than
taking that at face value, they re-ran the identical call against a clean pre-F6
`origin/main` worktree under the same live conditions and got the exact same 0/8,
proving F6 itself introduced no regression here. Tracing further via screenshots: the
iPad kept independently re-locking mid-session (Touch-ID lock screen, confirmed visually
3 separate times across the session) — unrelated to any of that night's 3 PRs. The
`'inspect-only'` rejection path itself behaved exactly as designed even under this
adverse condition (no crash, no false-accept, no mass-throw) on both branches; the gate
still passed on that basis, but nobody got a clean "cells accepted" demo that session.

Not investigated further yet — this is a rig/hardware observation, not a code defect
attributable to any specific PR. Worth a look if it recurs: is this ordinary hot-corner
risk compounding over a long session of repeated slam activity (the same category PR #62's
and PR #78's gates both hit before), or something rig-specific (e.g. an actual Touch-ID/
passcode-timeout policy on the physical iPad tightening over session length)? Whoever
picks this up should start by checking whether the re-locks cluster right after
slam-heavy operations (measureBallistics, ipadGoHome swipes) specifically, or occur on a
plain elapsed-time basis regardless of activity — that would distinguish "our own hot-
corner risk accumulating" from "iOS's own auto-lock timer," which point to very different
fixes.

## StreamerKeepalive doesn't support proxyUrl (macOS loopback-proxy deployment)  [RESOLVED, 2026-08-26]
Originally deferred (see below) on the assumption the proxied macOS path was a secondary,
retry-once-covers-it-well-enough concern. georgs-mac-mini's hardware gate on the streamer
idle-stop fix's first PR (#90) found this wrong: the gap was LIVE on their node — the exact
node that reported the original bug — because retry-once has nothing to retry against when no
code path on that node ever opens `/api/ws` at all (StreamerKeepalive was unconditionally
`null` there). Confirmed three independent ways (15s of pure REST polling never self-recovers;
a bare WS connect-then-close DOES wake ustreamer in ~1.8s; StreamerKeepalive is the only `/api/ws`
caller in the codebase) plus a real `moveToPixel` failure end-to-end. Promoted to active/high
priority the same session.

Fixed via `ConnectTunnelAgent` in `streamer-keepalive.ts`: a hand-rolled `https.Agent` subclass
(raw TCP connect to the proxy, hand-written `CONNECT host:port HTTP/1.1`, then `tls.connect()`
on the same socket once the `200` arrives) rather than a new `https-proxy-agent` dependency —
`ws`'s `ClientOptions.agent` wants a classic Node `Agent`, which this satisfies directly. Pattern
reused verbatim from georgs-mac-mini's own hardware-verified `scratch/ws-holder.mjs`
(tinyproxy-based) rather than re-derived from scratch, per their PR follow-up message with the
full working code + gotchas (double `rejectUnauthorized`, HTTP Basic vs X-KVMD header auth
through the tunnel, `?stream=1` explicitness). Tested against a real loopback CONNECT proxy +
real self-signed-cert TLS `ws` server (`streamer-keepalive-proxy.test.ts`), not just DI'd fakes —
the raw-socket/TLS-handoff mechanics are the one genuinely new, risky piece this added.

---

Original deferral (2026-08-26, superseded above): the streamer idle-stop fix
(`src/pikvm/streamer-keepalive.ts`, closes the "screenshot/streamer 503 when kvmd idle-stops
ustreamer" task) holds a persistent `/api/ws` WebSocket connection via the `ws` package to keep
kvmd's stream-client count above zero. `PiKVMConfig.proxyUrl` (the macOS Local Network privacy
workaround — routes REST traffic through a loopback HTTP CONNECT proxy via undici's
`ProxyAgent`) had no equivalent wired up for this WS connection: `ws`'s `ClientOptions` takes a
classic Node `http(s).Agent`, not undici's `Dispatcher` interface, so undici's `ProxyAgent`
couldn't be reused as-is. Not implemented in the first PR because it looked out of scope
(headless nixos-developer-system usage is unproxied) and would need a new proxy-agent dependency
or a hand-rolled CONNECT-tunnelling `http.Agent` — turned out to be needed after all, see above.

## Cascade batch-size fix (PR #93) real on-box latency — 1.6-1.8x, not the ~6x extrapolation  [RESOLVED, 2026-08-28]
task_484bed055820's hardware gate (georgs-mac-mini) measured a ~5-6x speedup on an ISOLATED
`findCursorByV8FullFrame` call (57-67ms vs 315-344ms) when a hint narrows the cascade's search
window instead of scanning the whole region — and separately measured a real E2E `curve-one-shot`
win too (median 1881ms→1640ms, ~13%), but flagged that number as Mac-hardware-only (the full-scan
baseline there is only ~330ms, vs the 15-25s the fix targets on real Pi4) and explicitly declined
to extrapolate the ~6x isolated ratio onto Pi4 E2E latency without a direct measurement.

Once deployed live to pikvm01, georgs-mac-mini ran that direct measurement: `move_to` 25341ms→
13854ms median (1.83x), `click_at` 39795ms→24807ms median (1.60x) — a genuine, solid win, but
meaningfully smaller than the ~6x the isolated-detection ratio alone would suggest. Likely
explanation (their diagnosis, not independently re-confirmed further): the cascade detection call
is only part of a move's total wall-clock — HID emit chunking, settle sleeps, and other fixed
per-operation overhead don't shrink just because the detector's own crop count did, diluting the
pure-detection speedup at the whole-operation level. Accuracy held up (healthy landings, one safe
detection-failure skip out of 3 `click_at` attempts, consistent with pre-existing behavior).

Recorded here because PR #93 is already squash-merged (2097bf9) — this real, deployed-hardware
number is the fact worth keeping, not the pre-deployment extrapolation. No further action; noted
as a general caution for future latency-fix claims in this codebase: an isolated component-level
speedup ratio does not automatically carry over to the enclosing operation's E2E ratio when the
component isn't the operation's only cost — always get the direct on-box measurement before
quoting a number past the specific thing that was actually timed.
