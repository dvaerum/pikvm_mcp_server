# iPad cursor detection — troubleshooting log

This document captures what we learned debugging the iPad
`pikvm_mouse_click_at` accuracy problem on real hardware, what worked,
what didn't, and the long-term direction. Written so the next person
who touches `move-to.ts` doesn't have to re-derive everything from
commit messages.

## 🩺 Diagnostic-first protocol

When `pikvm_mouse_click_at` misbehaves on iPad, **run
`pikvm_health_check` FIRST** before reaching for the algorithm. The
report surfaces every common environmental failure mode in one call:

- **Server version mismatch** → deployed server is stale; redeploy
  before debugging code.
- **`mouseAbsoluteMode: true` for an iPad target** → startup HID
  detection failed; restart the MCP server.
- **iPad bounds detection failed** → screen is dark or showing an
  all-black canvas; the cursor-detection algorithms have nothing
  to work with.
- **`Screen brightness: mean<50/255 ⚠ VERY DIM`** → iPad
  auto-brightness has dimmed the display below the cursor-detection
  threshold (Phase 37/38). Software-side wakes (swipe, key, mouse
  movement) do NOT restore brightness. Manually adjust the iPad's
  display brightness slider; consider turning Auto-Brightness OFF
  per `docs/skills/ipad-setup.md`.

Most "click_at suddenly stopped working" reports turn out to be
environmental (dim screen, locked screen, stale deployment) rather
than algorithmic. Save yourself the wild goose chase.

## ⚠️ DEPLOYMENT FRESHNESS — IMPORTANT

This codebase has shipped many critical iPad-safety fixes since
`da3a434` (2026-04-25, the introduction of `forbidSlamFallback`).
A deployed server older than that commit will silently fall back to
slam-to-corner on iPad targets when detect-then-move fails — and
slam triggers the iPadOS hot-corner gesture, which **re-locks the
iPad mid-session**.

Live-verified on 2026-04-26: a deployed server lacking
`forbidSlamFallback` enforcement re-locked the iPad on the first
`pikvm_mouse_click_at` against the home screen. Symptom in the
algorithm message: `WARNING: detect-origin fell back to slam; iPad
may have re-locked via hot corner.` Post-click screenshot: lock
screen, not Settings.

**Always confirm the deployed server is at least at commit
`da3a434` before live-testing on iPad.** Rebuild + restart the
MCP server after pulling main if you see the slam-fallback warning.

### Phase 45 attempt + revert (v0.5.33, 2026-04-26): post-move template-driven micro-correction triggers gestures

Tried adding a post-moveToPixel correction loop that uses template-match
(empirically more reliable than motion-diff: NCC scores 0.97 in
benches) to find the cursor and emit small mickeys toward the target,
iteratively. Goal: converge from ~30 px residual to <10 px reliably.

Live result: triggered the iPad APP SWITCHER. The correction emits
pushed cursor down to the iPad's bottom edge, where iPadOS's swipe-up-
from-bottom gesture activated and opened the multitasking switcher.
Same destructive-gesture failure mode as Phase 32's hot-corner-on-
top-left, just on a different edge.

Contributing factors:
1. The 80 ms inter-iteration settle was shorter than the streamer's
   ~235 ms latency. Subsequent screenshots showed STALE cursor
   positions, leading the loop to emit additional motion thinking
   the cursor hadn't yet moved → drift compounded.
2. iPadOS's pointer-acceleration variance turned the small per-
   iteration emits into unpredictable larger pixel jumps under some
   conditions, the same variance that bounds the iconToleranceResidualPx
   ceiling.
3. No bounds-aware safety: the loop didn't refuse to emit toward the
   iPad bottom edge.

REVERTED. The microCorrectionIterations option remains in the type
for future opt-in experimentation but defaults to 0. The architectural
30 px residual ceiling stands; correcting beyond it without bounds-
aware gating is destructive.

### Phase 40 attempt + revert (v0.5.28, 2026-04-26): the icon-tolerance ceiling

Live 5-trial bench against Settings (1027, 832) on a clean, bright iPad
home screen with v0.5.27:

```
Trial 1: verified=false, residual=185.5, mode=predicted, screenChanged=false
Trial 2: verified=true,  residual=32.3,  mode=motion,    screenChanged=false
Trial 3: verified=true,  residual=29.0,  mode=motion,    screenChanged=false
Trial 4: verified=true,  residual=28.5,  mode=template,  screenChanged=false
Trial 5: verified=true,  residual=28.4,  mode=template,  screenChanged=false
```

4/5 trials had cursor verified at residual 28-32 px. ALL 5 clicks
missed the Settings icon — `screenChanged: false` across the board.
The default `iconToleranceResidualPx=40` lets the algorithm exit at
~30 px residual, but iPadOS's icon hit-area / pointer-snap radius is
TIGHTER than 30 px. The cursor lands in the gap BETWEEN icons.

Phase 40 attempt: tightened `iconToleranceResidualPx` from 40 → 20.
Re-ran the bench; result was WORSE:

```
Trial 2: residual=33.0,  mode=template, screenChanged=false (missed)
Trial 3: residual=156.9, mode=motion,   screenChanged=true  (WRONG TARGET — Calendar opened)
Trial 4: residual=32.0,  mode=template, screenChanged=false (missed)
Trial 5: residual=149.1, mode=motion,   screenChanged=true  (WRONG TARGET — Calendar opened)
```

The tighter tolerance caused more correction passes that compounded
acceleration variance. Motion-diff started false-positive-verifying
widget-animation clusters as cursor at residuals 149-157 px. Clicks
landed on the calendar widget instead of Settings.

REVERTED to `iconToleranceResidualPx=40`. The 30 px residual gap to
the icon hit area is a HARD CEILING on iPad with this approach —
not a tunable. Conclusion documented as a closed avenue.

**Real path forward: keyboard-first via `pikvm_ipad_launch_app`.**
Verified 100% reliable across many launches this session. Cursor
clicks should be reserved for UI elements that have no keyboard
equivalent (modal dialogs, custom controls).

### Phase 37 (v0.5.22, 2026-04-26): dim screen → detection failure

Live test 2026-04-26: cursor detection failed in `clickAtWithRetry`
across 3 retries on the iPad home screen. The screenshot showed the
iPad display in a visibly dimmed state — overall pixel brightness was
~30-50/255 across the frame. The cursor's bright pixels (~150-200)
were ABOVE the brightness floor of 100, but the motion-diff signal
(post-emit position) was contaminated by the dim background where many
pixel deltas fell into the JPEG-noise-vs-cursor ambiguous range.

Symptom: `moveToPixel: detect-then-move failed (motion-diff and
template-match both returned no cursor)`. The probe ran (cursor moved)
but the motion-diff didn't find a clean cluster pair.

Workaround: wake the iPad display before clicking. Options:
- `pikvm_ipad_unlock` (also works on already-unlocked iPad — the swipe
  gesture wakes the screen).
- Send any keyboard input (Cmd+H, Escape) — but verified that this
  does NOT necessarily restore display brightness on iPadOS 26.
- Manually adjust iPad brightness via Settings.

Phase 37 surfaces this in `pikvm_health_check`: the report now
includes mean RGB brightness with `⚠ VERY DIM` (mean < 50) or
`⚠ DIM` (mean < 80) warnings. Run `pikvm_health_check` whenever
click_at calls start mysteriously failing — the brightness report
will tell you whether to debug the algorithm or the environment.

### Phase 32 (v0.5.16, 2026-04-26): explicit-strategy slam guard

Live-verified again 2026-04-26: even with `forbidSlamFallback`
shipped, an LLM caller passing `strategy='slam-then-move'`
explicitly STILL slammed and STILL locked the iPad — because the
existing guard only protected the auto-fallback path, not the
explicit-strategy path. v0.5.16 adds `forbidSlamOnIpad` (default
true), which calls `detectIpadBounds` before slamming and refuses
when iPad-portrait letterbox is detected. The MCP tool description
for `pikvm_mouse_click_at` and `pikvm_mouse_move_to` now warns
against `slam-then-move` on iPad targets.

## Symptom

`pikvm_mouse_click_at(x, y)` against an iPad displayed in a 1920×1080
HDMI letterbox (PiKVM in `mouse.absolute=false` relative-mode) lands
the cursor 100–500 px away from the requested target on a busy home
screen. Modal dialogs and quiet pages mostly work; the home screen
with animated widgets is where everything falls apart.

## Architectural constraints (fixed; not solvable in software)

1. **iPadOS pointer acceleration** is non-disableable. It varies
   1.0–2.0× per move and is asymmetric (+x and −x have different
   effective ratios in the same context).
2. **PiKVM HID descriptor is 8-bit relative**. Each emission is a
   signed byte in mickeys; iPadOS applies its own ballistic curve on
   top.
3. **iPadOS hides the pointer after ~1 second of inactivity**. A
   screenshot taken during the fade window contains no cursor pixels.
   This is the root of most detection failures.
4. **The home screen is animated** — clock seconds, weather widgets,
   calendar — which produces colored cluster noise in motion-diff.

## Detection strategies tried, in order

The codebase has accreted a layered detection pipeline. Each layer
addresses a specific failure mode of the layer above it.

### Motion-as-probe (`detectMotion` in `move-to.ts`)

Diff two screenshots taken before and after a known mouse emission.
The cursor is the cluster pair whose displacement matches the
commanded move.

**Failure modes:**
- iPadOS animated widgets produce many cluster pairs that look like
  the cursor by size and direction (clock-second-hand: ~25 px,
  +1 px/sec). Wrong pair selection → wrong direction correction →
  cursor drifts further from target.
- When the cursor is faded in either frame, the corresponding
  cluster is missing and pair selection has no anchor.
- When `brightnessFloor` only checks frame B, dim-wallpaper backdrops
  (revealed at the cursor's old position) silently fail the
  brightness check, which means the *pre*-cluster never forms even
  when the cursor is bright in frame A. → fixed in Phase 8.

### Template-match (`findCursorByTemplateDecoded`)

Normalised cross-correlation of a cached cursor template against a
single screenshot. No motion required. Cheaper than probe-and-diff.

**Failure modes:**
- Cached template was captured against one wallpaper context;
  scoring on a different backdrop drops 0.10–0.15 below threshold.
  → addressed by Phase 3 multi-template support.
- **Stable false positives at fixed iPad UI elements** (clock area
  at ~(960, 200), score ~0.83). When cursor is faded, the highest-
  scoring location is one of these UI elements, not the cursor.
  Tightening the threshold made the bench fail outright (locateCursor
  fallback also failed) — see Phase 7 reverted.
- A bad template, captured from a wrong motion-diff pair, poisons
  every subsequent match into a self-reinforcing loop. → fixed by
  `looksLikeCursor` validation gate before persistence.

### Probe-and-diff (`locateCursor`)

Force the cursor to be visible by emitting a probe move, then diff
the before/after frames to find both pre-cluster (where cursor was)
and post-cluster (where cursor is now).

**Failure modes:**
- Probe magnitude too small on busy screens (10 mickeys × 1.0 ratio
  = 10 px — within the noise floor of widget animations). →
  partially addressed by adaptive probe-size sweep [10, 30, 60].
- Wakeup nudge before the probe doesn't always succeed in re-
  rendering the cursor — observed empirically that on a long-idle
  iPad, even after a 30-mickey nudge, the next screenshot may still
  not show the cursor.
- Stale `brightnessFloor` (170 default) culled the pre-cluster on
  dim wallpapers — fixed by lowering to 100 in `locateCursor`'s
  override. Phase 8's OR-across-frames brightness check was a
  deeper fix.

## Phase-by-phase log

| Phase | Commit | What it does | Effect |
|---|---|---|---|
| 1 | `300e959` | Cluster-level achromatic filter on post-candidates | Rejects colored-widget noise without harming anti-aliased cursor edges. Ships. |
| 2 | `7c09951` | Template-validated pair selection re-ranks candidate pairs by combined geometric + template score | Helps when motion-diff produces multiple plausible pairs. Doesn't fire when motion-diff finds zero pairs. |
| 3 | `3ca37c0` | Multi-template support: directory-backed set, NCC dedup, capacity cap | Modest improvement across backdrops; legacy `cursor-template.jpg` is auto-migrated. |
| 4 | `271b287` | Blind-pass circuit breaker — abort the correction loop after 2 consecutive predicted-mode passes | Prevented a 9-pass / 213 px overshoot caught live; capped at 3 passes / 180 px. |
| 5 | `8f15e84` | +30/−30 wakeup nudge before origin template-match screenshot | Bench undetected: 9/10 → 7/10 of 10 trials. |
| 6 | `1b33174` | Open-loop edge clamp — refuse to emit a move whose projected landing is off-screen | Defensive; doesn't move the typical case but bounds a tail-risk failure mode. |
| 7 | `0b59b29` (then reverted by `b5b0468`) | Tighter origin-template threshold (0.83 → 0.89) to reject FP UI matches | Made bench fail 10/10 because `locateCursor` fallback was already broken. Reverted. |
| 8 | `0b59b29` | `diffPixels` brightness floor checks A or B (was B-only) | Fixes pre-cluster formation on dim wallpapers — a real bug. Existing tests had pinned the buggy behaviour as if it were intentional; rewritten. |
| 9 | `b5b0468` | Cap per-correction emission at 25 mickeys (linear) / 80 (gross) | Worst-case 5-trial residual: 553 → 275 px. Bounds blind-mode damage but doesn't fix accuracy. |
| 10 | `9068c7a` | `isOriginProbeMatchPlausible` helper + always-locateCursor evaluation (reverted) | locateCursor itself fails 3/5 on iPad home screen, so always-probe is strictly worse. Helper kept for future redesign. Troubleshooting doc added. |
| 11 | `595d84f` | Locality-aware ranking in `findCursorByTemplateSet` — prefer per-template matches near a hint over far high-scoring FPs | Catches the (781, 713) 0.944 FP that would otherwise beat the (1057, 837) 0.909 real-cursor match. 5-trial worst-case 275 → 207 px. |
| 12 | (helper only, not wired) | `isRatioUpdatePlausible` — reject ratio updates that drift > 2× from prior or fall outside [0.5, 4.0] | Wired at 2× threshold made *every* trial regress to 178-207 px because legitimate context-switch adaptations from default (3.04, 5.28) to true iPad (~1.5–2.5) were being blocked. Helper kept for future wiring at a looser threshold (3× or 4×) once we have data on how often legitimate updates exceed 2×. |
| 23 | (this iteration) | Click verification reporting — `pikvm_mouse_click_at` takes a pre-click screenshot, clicks, takes a post-click screenshot, diffs them, and reports `screenChanged` (≥0.5% pixels differing) plus a human-readable verdict. New `src/pikvm/click-verify.ts` with 10 unit tests. Implements the "click-and-verify-result wrapper at the MCP layer" recommended in the long-term answer section below. Does not change clicking behavior; the agent calling the tool can use the new signal to decide on retry/move-on. Opt-out via `verifyClick: false`. |
| 24 | (this iteration) | Verification-lag tracking (Direction 3, partial) — `MoveToResult` now exposes `passesSinceLastVerification: number`. The operator-facing message appends "(last verified N pass(es) ago — N predicted passes since; cursor may have drifted, accuracy uncertain)" when the residual was last confirmed by motion-diff or template-match more than zero passes ago. Does NOT change correction-loop exit semantics yet — that's the larger Direction 3 refactor. Pure additive honesty improvement: callers (and the operator reading the message) can now distinguish "I just verified residual = 25 px" from "I verified residual = 25 px three predicted passes ago". 3 new tests with a uniform-black-frame mock client to force every pass into predicted mode. |
| 25 | f9393b3 | Server-side retry-on-miss in `pikvm_mouse_click_at` — new `clickAtWithRetry` orchestrator loops moveToPixel + click + Phase-23 verify, retrying on screenChanged=false. Each retry runs a fresh detect-then-move probe (independent trial, doesn't compound errors like Phase 17). 6 new tests with state-tracking mock client. **Live result: didn't help iPad clicks.** All 3 retries on Settings target landed nowhere useful (each at ~0.01% screen change). Conclusion: retrying random misses is necessary but not sufficient — same systemic failure mode reproduces per attempt. |
| 26 | (this iteration) | Probe-driven correction loop (Direction 2) — new `moveToPixelProbeDriven` in `src/pikvm/move-to-probe-driven.ts`. Replaces motion-diff verification with `locateCursor` probes that emit a known small motion + observe to get ground-truth cursor position each iteration. 8 unit tests with injected probeFn (deterministic + perturbed cursor models, all pass). **Live result on iPad home screen: still doesn't reliably hit small icons.** Initial naive run: position bounced ±600 px between iterations because locateCursor false-positives picked widget edges as cursor. Added plausibility check (reject probes implying jump > 3× expected step + 80 px allowance). With check enabled, algorithm "converges" in belief (residual 18 px reported, claimed cursor at (1028, 850) for Settings target) but post-click screenshot shows cursor visible at the right edge of the screen — algorithm's belief is wrong. Conclusion: probe-driven cannot escape the root limitation that small mickey commands cause UNPREDICTABLY large cursor displacements on iPad (>10× nominal). The cursor's response variance is so high that closed-loop control on `locateCursor` observations is not reliable. |
| 27 | (this iteration) | `locateCursor.expectedNear` spatial hint — `locateCursor` now accepts `expectedNear: Point` + `expectedNearRadius` (default 200 px). When set, candidate cluster pairs whose post-centroid is far from the hint are HARD REJECTED at the pair-selection gate; remaining candidates get a tie-break score bonus for proximity. Same pattern as Phase 11's `findCursorByTemplateSet`. Wired into Phase 26's probe-driven loop so each iteration's probe is anchored to the previous iteration's known cursor position. **Live result on iPad home screen: did NOT fix it.** With locality filter at radius 250: probes lock onto a fixed widget false-positive (algorithm reported cursor stuck at (773, 387) for 8 iterations). The locality filter prevents the worst noise (Phase 26's ±600 px bouncing) but creates a feedback loop where one false positive becomes a stable anchor for subsequent probes. Useful as opt-in for quiet backdrops where locateCursor would otherwise drift between equally-plausible candidates; not useful on the iPad home screen. |

## Phase 29 in progress — cursor visibility findings (2026-04-26 evening)

User pushed back on "ceiling reached" — cursor click is the project. Resumed.

### Key live finding: weak wakeup is the locateCursor failure

`locateCursor`'s default wakeup is +30 then -30 X mickeys (round trip,
net zero displacement). On the iPad observed live, this is INSUFFICIENT
to make the cursor visible in the BEFORE screenshot. Result: 6/6
consecutive locateCursor calls returned null (`probe-ensemble` mode).

A stronger one-shot motion (-120 X mickeys with no return + 500 ms
settle to outlast streamer + render latency) DOES make the cursor
visible: confirmed via `cursor-visibility` mode → cursor clearly
rendered at ~(1010, 893) in the post-motion screenshot.

### Template cache poisoning

The `data/cursor-templates/` cache had templates that scored 0.99+
on iPad UI elements rather than the actual cursor. Specifically
template #3 of 4 stably matched (1112, 276) — the right edge of the
Maps widget — at 0.996 score, beating the real cursor every time.
Source of poisoning: `maybePersistTemplate` runs after a
"successful" motion-diff, but motion-diff false positives caused
non-cursor regions to be persisted as "cursor templates", which
then make every subsequent template match worse.

Purged cache. Re-capturing via motion-diff "biggest cluster" also
unreliable — picks widget animation clusters that happen to be
larger than the cursor cluster.

### Next iteration's attack vectors

1. **Stronger locateCursor wakeup**: replace +30/-30 round trip
   with +120/-120 round trip OR +120 one-shot (no return). Test
   if locateCursor success rate improves.
2. **Smarter template capture filter**: when picking the cluster
   to extract a template from, require achromatic (Phase 1 filter
   already exists — apply it) + cluster size in expected cursor
   range (4-50 px) + brightness floor.
3. **Slam-bottom-right** as a safe known-position primitive
   (iPadOS hot corners are top-left and top-right; bottom-right
   appears safe). Use to put cursor in a known location for
   template capture and origin discovery.
4. **Ensemble probe**: emit N consistent motions with motion-diff
   between each pair, cluster the resulting positions, take the
   most-frequently-detected position as the true cursor. Real
   cursor is consistent; animation noise is random.

### Phase 29 follow-up (2026-04-26): locateCursor wakeup + sanity window fixed

Vector 1 SHIPPED. Three changes to `locateCursor`:

- **Wakeup**: changed from `+30/-30` round trip (net 0 displacement) to
  one-shot `-120` X mickeys. The cursor now reliably renders before
  the BEFORE shot.
- **probeDelta default**: 10 → 60. iPadOS amplifies small mickey
  emits up to ~20×, so a 10-mickey probe could displace the cursor
  beyond the previous [3, 40] px sanity window — pair selection
  silently failed. With probeDelta=60, cursor displacement (30-1200 px
  depending on iPadOS ratio) dwarfs animation-noise inter-cluster
  distances (typically <50 px), making pair selection robust.
- **Sanity window**: `[probeDelta * 0.3, probeDelta * 4]` →
  `[probeDelta * 0.3, probeDelta * 25]`. The wider upper bound
  accepts cursor pairs displaced by iPadOS amplification while still
  rejecting noise pairs (which fall below the lower bound).

**Live verification**: ran `probe-ensemble 6` after the change.
Result: 6/6 probes returned non-null positions (was 0/6 before).
Density analysis showed 4 of 6 probes clustered at ~(1140, 985),
which matches the cursor's recent position. The remaining 2 probes
returned widget false positives — but density-based selection
correctly identifies the true cursor.

**End-to-end click_at via test-client `click-verify`**: locateCursor
now successfully detects the origin (was failing before).

### v0.5.3 — three more wins (2026-04-26 evening)

After locateCursor was fixed, three follow-up bugs surfaced and got
fixed in turn:

- **detectMotion postWindow EXPAND-FALLBACK**: when no post candidate
  within 600 px of predicted landing, expand to all sized clusters.
  Mirrors the pre-window fallback that was already there. Live: open-
  loop motion-diff went from 100% failure to successfully picking
  cursor pairs (live ratio 2.881 verified).
- **LINEAR-PHASE PREDICTED-MODE BAILOUT**: when a small linear
  correction can't verify, REVERT currentPos to last verified
  position instead of trusting prediction. Was actively poisoning:
  33 px verified residual → "refined" to 1 px believed via predicted
  → click missed because actual cursor was elsewhere.
- **OSCILLATION GUARD**: if a verified correction makes residual
  1.5× worse than previous verified, revert to better previous
  position and exit. Live-observed: 5 motion-verified passes
  oscillating between (900, 732) and (1132, 973) for target
  (1027, 832).

### v0.5.4 — icon-tolerance early exit + looser template threshold (2026-04-26 evening)

- **ICON-TOLERANCE EARLY EXIT** (move-to.ts): new option
  `iconToleranceResidualPx` (default 40 px). When the cursor is
  VERIFIED (motion or template) within this radius of the target,
  STOP — further correction risks over-correction. iPad icons
  are ~80 px wide; a click within 40 px of centre registers on
  the icon.
- **TEMPLATE-MATCH THRESHOLD LOOSENED**: correction-pass minScore
  0.95 → 0.88. Live trial 4 caught a real cursor match at
  score 0.947 being rejected. Real iPad cursor matches typically
  score 0.85-0.97; 0.95 was rejecting too many legitimate matches.
  Locality filter (expectedNear, radius 150 px — also widened
  from 100) is the primary FP defense; with locality enforced,
  0.88 is a safe threshold.

### v0.5.4 reliability bench (2026-04-26, 08:23): MIXED

After v0.5.4 trial 5 succeeded, I ran a 5-trial bench. Result: 5/5
reported "verified position" with residual 30-34 px (within icon
tolerance), but **0/5 actually changed the screen via Phase 23**.

Root cause: the cached `data/cursor-templates/` had FALSE-POSITIVE
templates. The looser 0.88 minScore threshold accepted
template-matches at consistent UI features (NOT the actual cursor),
and the icon-tolerance early exit then exited at a "verified"
position that wasn't really the cursor's position.

The trial 5 success was a fluke where the cursor happened to be
genuinely near (1058, 816). Subsequent trials all hit the FP.

The icon-tolerance exit is only as good as the verification beneath
it. Bad templates → false verifications → false-good early exits.

### v0.5.5 — slam-bottom-right anchor primitive (2026-04-26, 08:26)

LIVE-VALIDATED FINDING: saturating the cursor to the bottom-right
corner of the iPad screen via 30 repeated `mouseMoveRelative(127, 127)`
is **SAFE**. No hot-corner gesture triggered (top-left re-locks),
no app launched, no Control Center opened (top-right would). Cursor
reliably ends at ~(1190, 920) in the HDMI portrait frame.

This is a **known-position primitive** that bypasses the broken
`locateCursor` probe. From a known cursor position, we can compute
precise relative moves and capture FRESH templates from the actual
cursor (not from motion-diff false positives).

Next attack vector: a `moveToPixelFromCorner` flow that:
1. Slams cursor to bottom-right (known position)
2. Captures a fresh cursor template at that location (no
   motion-diff guesswork)
3. Emits relative move toward target
4. Template-matches the FRESH template (high score expected
   since the same cursor was just captured)
5. Verifies position; clicks when within icon-tolerance

The fresh-from-slam template should be MUCH better than the
motion-diff-captured cache that's been poisoning matches.

### Phase 30 cont. (2026-04-26, 10:08): PiKVM dual-mode mouse discovery

After 30 phases of iteration on the relative-mouse positioning
problem, found a configuration angle worth investigating.

**PiKVM docs** (https://docs.pikvm.org/mouse/) state PiKVM supports
TWO mouse modes:
1. **Absolute mode**: "the input device transmits the exact
   coordinates (X,Y) where the cursor should be moved. Works like
   touchscreens or drawing tablets."
2. **Relative mode** (current config on this PiKVM): standard
   mouse offsets.

For V2+ platforms (this PiKVM is v2 per `/api/info`: "Raspberry
Pi 4 Model B Rev 1.1, model: v2"), DUAL MODE is supported —
switch between absolute and relative without reloading.

**Live API check** (2026-04-26, 10:08):
```
curl /api/hid → mouse.outputs.available: []
```
Empty `outputs.available` means dual-mode is NOT currently enabled
in this PiKVM's `/etc/kvmd/override.yaml`. `mouse.absolute: false`
is hardcoded.

**The hypothesis worth testing**: if PiKVM were configured for
absolute mode, iPad might accept the HID descriptor as
touchscreen-like input. iPadOS handles touchscreen input
deterministically (no pointer-acceleration variance). This would
bypass EVERY problem documented in this doc.

**Required to test (server-side config, NOT MCP code)**:
1. SSH or web-terminal into the PiKVM (https://pikvm01.bb.vcamp.dk/extras/webterm)
2. Edit `/etc/kvmd/override.yaml`. Add:
   ```yaml
   otg:
     devices:
       hid:
         mouse:
           absolute: true
   ```
   OR enable dual-mode (per PiKVM docs):
   ```yaml
   kvmd:
     hid:
       mouse:
         absolute: true
   ```
3. `systemctl restart kvmd`
4. Re-test `pikvm_mouse_move(x, y)` (relative=false). The MCP
   server's existing absolute-mode guardrail will permit it once
   `/api/hid` reports `mouse.absolute: true`.

If this works, ALL the iteration documented in this troubleshooting
doc becomes obsolete — absolute coordinates means deterministic
positioning, no variance, single-shot precision.

If it doesn't work (iPad refuses the absolute HID descriptor), we
fall back to the multi-trial retry approach with Phase 23 feedback
that's already shipped.

This is the single biggest unknown remaining. **Recommend the user
attempt this config change before more cursor algorithm work.**

### Phase 30 cont. (2026-04-26, 09:53): same emit, different result

Ran two identical-looking trials of corner-click(1027, 832, ratioX=3, ratioY=variable):

- Trial A: emit (-54, -11). Y moved 225 px. Cursor landed at App Store row.
- Trial B: emit (-54, -4). Y moved 95 px (DOWN, not up!). Cursor landed below dock.

Both trials: same slam pattern, same 500ms settle, same emit ordering.
Different mickey counts in Y, but the per-mickey ratio is wildly
different — and Trial B's emit even reversed direction (cursor moved
DOWN despite -4 mickeys = up command).

This is the fundamental iPadOS variance that makes single-shot
cursor positioning unreliable. The same input pattern produces
different outputs run-to-run.

**Conclusion**: single-shot precise positioning on iPad with USB
HID mouse is not achievable. Reliability MUST come from iteration:
1. Slam → known approximate position
2. Emit toward target (variable result)
3. Take screenshot, find cursor
4. If close enough, click; else iterate
5. After click, verify via Phase 23
6. If wrong app, dismiss + retry

The architecture exists. The remaining hard problem: corrective
emits FROM a settled cursor produce near-zero displacement, so
each iteration's correction needs to either re-warm the cursor
(another slam) or use chained-rapid emits to overcome damping.

The most pragmatic approach: PHASE 25 RETRY at the click_at level
(slam + emit + click as one trial; if Phase 23 detects wrong
app, dismiss + retry with adjusted parameters). Each retry is an
independent trial with iPadOS-fresh state. Cumulative success
rate over multiple retries is acceptable.

### Phase 30 cont. (2026-04-26, 09:39): iPadOS damps SETTLED cursor

Built `burst-chain-test` mode: emits N rapid bursts after the cursor
is in mid-screen settled state. Tested:
- 5× (30, 30) at 30ms gaps from settled cursor: 0 px movement.
- 5× (-30, -30) at 5ms gaps from settled cursor: 0 px movement.

Even rapid (5ms) gaps don't help. **iPadOS truly damps small inputs
to a settled cursor.**

What's different about the corner-click trials that DID move cursor:
- Slam (saturated cursor) + small wake + immediate single fast emit
  while the cursor's ballistic state was still warm from the slam
- Specifically: slam → 200ms → -20,-20 wake → 280ms settle → emit

The 280ms settle is SHORT enough that the cursor isn't fully damped.
A subsequent (-54, -29) single emit then moves cursor 165, 225 px.

vs. burst-chain-test:
- slam → wake → 280ms → take shot → emit -80,-80 → 350ms → take shot
- Then emit chained bursts. By this point cursor has had 350ms+ to
  settle, and small bursts get fully damped.

**Working hypothesis (refined)**: iPadOS pointer input has a "warm
window" right after the cursor is in motion. Inputs during this
window get amplified by the existing ballistic state. After the
cursor settles (~200-300ms post-motion), small inputs are damped
to near-zero.

To get reliable cursor positioning:
- Each move must START with a "warming" motion (single big emit
  while cursor is moving from a previous emit, OR slam-saturation)
- Then the actual positioning emit happens during the warm window
- The cursor then lands somewhere proportional to total emit
  velocity, not just mickey count

This explains why progressive open-loop didn't help (Phase 22):
each progressive chunk lets cursor settle, then small chunks get
damped.

### Phase 30 cont. (2026-04-26, 09:25): mid-screen template capture works

Built `mid-screen-template` mode AND integrated into `slam-iterate-click`:
1. Slam BR (cursor at corner ~1283, 1008)
2. Take corner-shot
3. Emit -80, -80 to move cursor away from edge
4. Take mid-screen-shot
5. Motion-diff between corner-shot and mid-screen-shot → produces
   2 cursor clusters (corner + mid-screen)
6. Pick cluster FURTHEST from corner = mid-screen cursor position
7. Filter for achromatic + cursor-sized
8. Extract clean template at mid-screen position

**Live result**: motion-diff successfully found mid-screen cursor at
(750, 152) with 38-px cluster. Captured clean 24×24 template from there.

This unblocks the FRESH-template-from-known-position story. The corner
template was contaminated by edge/dock pixels; the mid-screen template
should be cleaner cursor + wallpaper context.

But: in the iterate loop, subsequent bursts produced match scores that
either fell below threshold or found false positives. Two new findings:
- Single -80,-80 emit on slam-saturated cursor moved it ~700-900 px
  (much more than typical 200 px estimate)
- Subsequent +50,+50 emits from mid-screen position seemed to barely
  move the cursor (template-match found same position)

iPadOS ballistic curve depends on prior cursor STATE (saturated vs
mid-screen) more than I realized. The "first burst from saturation"
gives a different response than "Nth burst from mid-screen".

Architectural piece is solid. Tuning remains.

### Phase 30 cont. (2026-04-26, 09:10): slam-iterate-click + strict locality reject

Built `slam-iterate-click` test mode: slam BR → capture FRESH
template at corner → loop {emit fast burst → screenshot → template-
match cursor with strict locality reject → click when within
tolerance}. Added strict locality reject in caller (the existing
findCursorByTemplateSet only PREFERS within-radius, falls back to
best-score far match if none qualify).

**Live trial result**: first burst (-50, -44) mickeys moved cursor
from (1283, 1008) to ~(1245, 953) (live screenshot inspection).
Template-match found a high-scoring (0.74) FALSE POSITIVE at
(1028, 312), 741 px from cursor's actual position. Strict locality
reject correctly aborted (was far beyond 300 px radius from belief).

So the architecture is right (slam → template → burst → re-find →
click), but the CAPTURED TEMPLATE itself doesn't reliably re-find
the cursor in subsequent positions. The 24×24 region captured at
extreme BR corner (1283, 1008) is on the screen edge — it includes
edge/dock pixels, not just cursor. When cursor moves AWAY from
edge, its appearance in the new context doesn't correlate well
with the edge-clipped template, so a UI feature elsewhere wins.

Next iteration: capture template AFTER first move (not at corner),
when cursor is in mid-screen with consistent backdrop. The flow:
1. Slam BR (known position)
2. Emit small move to pull cursor away from edge
3. Take screenshot
4. Use slam-anchor's known mickey-to-displacement OR pick the
   nearest cursor-shaped cluster via motion-diff between slam-shot
   and post-move-shot
5. Capture template from that mid-screen position
6. NOW iterate: emit move, find via fresh-mid-screen-template,
   click when close.

### Phase 30 cont. (2026-04-26, 09:00): slow-chunked emit is NEARLY NO-OP

`slam-aim-click` mode: slam BR (cursor at ~1283, 1008) → capture
fresh template → emit chunked move → template-match.

**Live**: emitted 9 chunks of (-5, -5) mickeys with 100ms pauses
between each (total: -45 mickeys per axis). Result: cursor moved
only ~8 px in Y, ~1 px in X. Fresh template found cursor at
(1284, 1000) — basically same as starting position (1283, 1008).

So slow, paced chunked emits are NEARLY NO-OP on iPadOS. Combined
with the earlier "single fast emit moves ~220 px regardless of
mickey count" observation:

**iPadOS pointer behavior model (working hypothesis)**:
- Each HID call is treated as a "pointer event"
- iPadOS applies a ballistic curve where event SPEED matters more
  than mickey count
- Single fast call → big ballistic kick → ~200 px per axis,
  approximately constant
- Slow paced calls → iPadOS dampens, treats as steady-state pointing
  → very small per-call displacement

Implications:
- Open-loop relative moves ARE achievable but require burst-fast
  HID calls, not slow chunked ones
- Each "burst" advances ~200 px; multi-burst chains can reach
  longer distances
- Pause BETWEEN bursts (≥1s for cursor render+fade) lets each burst
  be treated independently, but loses cursor visibility
- Pause WITHIN bursts (≥100ms) dampens the ballistic curve

The slam-BR primitive gives a guaranteed known-cursor anchor.
Fresh template capture from there works (template scored 0.744 in
trial above, cursor visibly at the corner). The chain works.

What's still needed: precise relative movement. Need to find the
right burst pattern that produces ~controlled 200px-per-burst
displacement, then chain bursts to reach target with feedback.

### Phase 30 in progress (2026-04-26, 08:39): slam-BR + open-loop emit, no verify

Implemented `corner-click` test-client mode: slam BR (cursor at known
~(1190, 920)) + emit relative move toward target + click + verify
via Phase 23.

**Trial 1**: target Settings (1027, 832), ratio=3.0 X & Y
- Emit (-54, -29) mickeys
- Phase 23: 29.02% screen change → click landed on **App Store**
  (one icon row above Settings)
- X was correct (verified ratio 3.02). Y overshoot.

**Trial 2**: target Settings (1027, 832), ratioX=3.0 ratioY=7.76
  (calibrated Y ratio from trial 1's 225px observed / 29 mickeys)
- Emit (-54, -11) mickeys
- Phase 23: 27.91% screen change → click landed on **App Store**
  (same overshoot as trial 1)

### iPadOS amplification is NON-LINEAR with mickey count

The trial 1 → trial 2 calibration assumed iPadOS px/mickey is constant
for a given axis. It isn't. Trial 1 observed ratio 7.76 for 29 mickeys
on Y. Trial 2 emitted 11 mickeys on Y; if ratio was constant, expected
displacement = 11 × 7.76 = 85 px. Actual: ~225 px (same as trial 1
despite emitting 1/3 as many mickeys).

So the rule **is not** "mickeys × ratio = displacement". Smaller
emits get amplified MORE per mickey. This is consistent with Phase 18's
finding that "iPadOS caps per-HID-call displacement at ~60 px
regardless of mickey count" — but with a wrinkle, since trial 2's 11
mickeys produced 225 px, way above the 60 px cap.

The actual relationship appears to be that iPadOS pointer acceleration
treats mickey emits as "pointer velocity samples" and applies a
ballistic curve. A single fast HID call produces a large displacement
regardless of mickey magnitude (within reason).

**Implication for slam-anchor strategy**: open-loop relative moves
from a known corner cannot reach a precise target via mickey counting
alone. The chain has to be:
1. Slam BR (known anchor)
2. Emit relative move (lands SOMEWHERE near target with iPadOS variance)
3. Take screenshot, find cursor via FRESH template captured from the
   slam-anchor state (template captured from a verified-known cursor
   position is high-quality)
4. Compute residual, emit small correction (with awareness of non-
   linear ratio — small emits amplify more)
5. Repeat 3-4 until cursor is within icon-tolerance, then click

The slam-BR primitive remains valuable because it gives a deterministic
KNOWN cursor position that doesn't depend on locateCursor's broken
detection. That's the foundation. Next iteration: build the template-
verification step on top.

**Live trial 5 result (2026-04-26, 08:18)**:
```
Origin via detect-then-move at (886, 435).
Open-loop emitted 47X+67Y mickeys.
Motion-diff failed → template-match recovered cursor at (1058, 816)
  score=0.915 (would have been rejected at 0.95)
ICON-TOLERANCE EXIT: verified residual 34.9 px ≤ 40 px tolerance;
  click should land on icon hit area. Skipping further correction.
Phase 23: 26.88% screen change → click triggered an app launch.
```

This is the first live trial where the **algorithm correctly
exited at icon-tolerance with a verified position** and the click
triggered an app open. The pipeline of locateCursor → motion-diff
or template-fallback → icon-tolerance exit → click is now
demonstrably working end-to-end on the iPad.

330 tests still green across all the v0.5.x changes.

## Architectural ceiling reached (2026-04-26 evening)

After Phases 23–27, the codebase has explored every direction the
troubleshooting doc identified as "the actual long-term answer", plus
several refinements the doc didn't mention:

- Phase 23: post-click screen-change verification — works as designed.
- Phase 24: stale-verification flag — works as designed.
- Phase 25: server-side retry-on-miss — works mechanically; per-attempt
  hit rate on iPad home screen is too low for retries to help.
- Phase 26: probe-driven correction (Direction 2) — works in synthetic
  environments and on quiet backdrops; fails on iPad home because
  `locateCursor` itself fails on busy widget backdrops.
- Phase 27: `locateCursor` spatial hint (Direction 1 refinement) —
  prevents catastrophic drift but creates a different failure mode
  (false-positive lock-in).

**The final architectural conclusion:** USB HID mouse + iPadOS + the
animated home screen is a combination where the cursor cannot be
reliably detected and cannot be reliably moved. No amount of
algorithmic refinement on either side of the pipeline escapes this.

### Practical recommendation hierarchy (what actually works)

| Scenario | Reliability | Approach |
|---|---|---|
| Modal dismissal (OK button on dialog) | High | `pikvm_mouse_click_at` with default options. Backdrop is quiet, cursor visible, motion-diff and locateCursor both work. |
| Button inside an opened app | Moderate-High | `pikvm_mouse_click_at`. Fewer animated distractors than home screen. Use `verifyClick: true` (default) to catch the occasional miss. |
| iPad home screen icon | LOW (~20-50% per attempt) | Prefer keyboard launch via Spotlight: `pikvm_shortcut(["MetaLeft","Space"])` + `pikvm_type("Settings")` + `pikvm_key("Enter")`. Reserve `click_at` only for icons with no keyboard equivalent, and use `maxRetries: 3+` plus post-click screenshot inspection. |
| Resolution change / known cursor location | High | `pikvm_calibrate` + `pikvm_set_calibration` for absolute-mouse devices; `pikvm_auto_calibrate` for vision-based. iPad doesn't support absolute-mouse, so this only helps non-iPad targets. |

This matrix is the de-facto API contract for iPad scenarios. Future
contributors: do not attempt to "fix" iPad home-screen icon clicks by
patching the algorithm — every variant we've tried bottlemets on the
same OS-level limitations, documented above.

## Direction 2 (probe-driven) post-mortem — what we actually learned

Phase 26 was the most ambitious refactor attempted in this codebase. It
implements exactly what the troubleshooting doc's "long-term answer"
section recommends. It works correctly in synthetic environments
(unit tests pass with deterministic and perturbed cursor models). It
does NOT work reliably on the live iPad home screen.

The proximate failure mode was twofold:

1. `locateCursor` false-positives. On the iPad home screen,
   widget animations + the cursor's faded state in the BEFORE frame
   produce cluster pairs that are NOT the cursor. Trusting these as
   ground truth makes the algorithm's belief jump 200-600 px
   per iteration to fixed UI features.
2. `locateCursor` correct positives that don't predict useful steps.
   Even when the probe correctly identifies the cursor, the next
   small-mickey emit moves the cursor by a wildly variable amount
   (observed: −30 mickeys producing displacements of 0-600 px).

The plausibility check (reject probes implying improbable jumps)
filters out symptom #1 but lets symptom #2 dominate, with the
result that the algorithm "converges" in belief but the actual
cursor goes wherever iPadOS decides.

### Why the long-term answer in the doc didn't pan out

The doc said:
> "1. Treat origin as a first-class probe, not template-match opt
> Drop the template-match-as-origin shortcut. Every moveToPixel
> call starts with a locateCursor probe-and-diff that *guarantees*
> a freshly-detected cursor position."

This assumed `locateCursor` is reliable. On the iPad home screen,
it isn't — Phase 10's earlier finding was correct. We have a 65-
commit codebase of patches around the unreliable detection signal.

### What this means going forward

The HONEST architectural answer: **USB HID mouse + iPadOS is not a
reliable substrate for precise icon targeting.** The codebase's
keyboard-first recommendation (`AGENTS.md`: "Strong recommendation
for iPad targets: prefer keyboard workflows over cursor clicks")
is the practical solution.

For scenarios where keyboard isn't an option (modal dismissals,
tappable UI without keyboard equivalent), the right pattern is:
- Use Phase 23 + post-click screenshot inspection at the agent layer
- Retry on miss (Phase 25 is shipped, but the per-attempt rate is
  ~20-50% on iPad home screen → 4 retries gets ~95% cumulative)
- Accept that "click on small icon" is a probability-weighted
  operation, not a deterministic one

The probe-driven path (Phase 26) remains in main as `moveToPixelProbeDriven`
for use cases where the backdrop is quiet enough for `locateCursor` to
work reliably (modal dialogs, plain wallpapers, non-iPad targets).
It's NOT wired into `pikvm_mouse_click_at` because it's slower and
not better than the existing motion-diff pipeline on iPad.

## Live test (2026-04-26): Phase 23/24 first-ever real-hardware run — major insight

Ran the new `click-verify` mode in `test-client.ts` against the live PiKVM at `pikvm01.bb.vcamp.dk`. Target: Settings icon at HDMI (1027, 832), iPad portrait home screen, both screenshots captured.

**Algorithm self-report:**
- Origin via detect-then-move at (1150, 988)
- Open-loop emitted 145X+2Y mickeys, motion-diff verified live ratio 0.731 px/mickey
- 5 correction passes (5 gross, 0 linear); 2/5 used template/predicted fallback
- Reported `Final cursor at (925, 568); residual = 283 px`
- `passesSinceLastVerification = 0` (last update was claimed verified)

**Phase 23 verification:**
- 29.08% of screen pixels changed (602,996 / 2,073,600)
- `screenChanged = true`

**What actually happened (post-click screenshot inspection):**
- The Files app's "Recents" view opened
- Files icon position on the home screen is ~(1162, 470)
- So the click landed near (1162, 470), NOT at the algorithm's claimed (925, 568)
- Real-vs-claimed discrepancy: ~240 px in X, ~98 px in Y

### Critical insight

The algorithm's motion-diff verification produced a **false positive at (925, 568)** — likely a colored cluster on a wallpaper transition or weather-widget edge that scored well on motion-pair geometry. `passesSinceLastVerification = 0` because that pass was *claimed* verified, but the verification was wrong.

**Phase 24's "last verified N pass(es) ago" qualifier does NOT catch this case.** The verification was recent — just incorrect. Phase 24 only flags staleness, not wrongness.

**Phase 23's screen-change check, however, correctly identified that the click triggered a major UI transition.** It does not tell us *what* the transition was, but combined with a known-target screenshot it gives the calling agent a reliable "click had effect" signal independent of the algorithm's geometry.

### Practical implication for the calling agent

The robust pattern is:
1. Take a screenshot before clicking — note what's at the target.
2. Issue `pikvm_mouse_click_at(target)`.
3. Read the algorithm's residual claim AND Phase 23's `screenChanged`.
4. If `screenChanged === false` → click missed the UI element entirely (cursor on wallpaper or fade window). Retry.
5. If `screenChanged === true` BUT post-click screenshot does not show the expected destination → click landed on the WRONG UI element. Retry with a corrected target, or back out.
6. If post-click matches expected destination → success.

The algorithm's `Final cursor at (X, Y)` line is not trustworthy on the iPad home screen. Treat it as a hint, not a fact.

### What this means for fixing the algorithm

Two improvements suggested by this finding:

1. **Tighter motion-diff false-positive rejection.** The pair selected at (925, 568) wasn't the cursor — it was a widget or wallpaper artefact. Phase 1's achromatic filter should have rejected colored widgets, but evidently something slipped through (or the artefact was achromatic). Investigation: instrument detectMotion's diagnostic output to dump the rejected vs. selected pair details on every live trial; correlate with what's actually under the picked centroid.
2. **Phase 23 region-scoped diff.** The current `verifyClickByDiff` runs full-frame. Adding `region: { x: tx, y: ty, halfWidth, halfHeight }` to the wired call (already supported by the helper) would give finer-grained signals: "did the click target area light up specifically?" — which is harder to spoof than "did the screen change anywhere".

Both are concrete next-iteration candidates that don't require deep refactor.

### Trial 2 (2026-04-26): click(757, 832) → Books, all signals AGREED on miss

Second live click-verify trial, target Books icon on the quiet left side
of the home screen (away from animated widgets).

**Algorithm trace (verbose):**
- locateCursor probe: cursor pre=(888,301) post=(934,314), used as origin
- Calibration: X-ratio probed at 2.300
- Open-loop emitted 77X+99Y mickeys in 5 chunks
- Motion-diff: 11 total clusters, 10 cursor-sized, 8 achromatic. Pair selection failed: "1×6 cands considered, no pair passed direction/sanity filters."
- Template-match against 4 cached templates: best scores 0.849, 0.738, 0.327, 0.631 — all below the 0.95 correction-pass threshold.
- Algorithm: trusted prediction. `Final position not detected — click accuracy uncertain.`
- `passesSinceLastVerification = 1` — Phase 24 correctly flagged unverified.

**Phase 23 verification:**
- 0.005% of screen changed (112 pixels of 2,073,600).
- `screenChanged = false`.
- Message: "Click did not trigger a visible screen change. The click may have missed its target."

**Post-click screenshot inspection:**
- Cursor visible at ~(1100, 510), in the empty wallpaper region between Reminders and Maps icons.
- Click landed on wallpaper. No app opened. Phase 23's "no change" verdict is correct.

### Cross-trial pattern

| Trial | Target | Algorithm self-report | Phase 23 screenChanged | Reality | Signals consistent? |
|---|---|---|---|---|---|
| 1 | Settings (1027,832) | "verified" residual=283 (FALSE) | true (29%) | Click hit Files icon (wrong target) | Algorithm wrong; Phase 23 correctly says "something happened" |
| 2 | Books (757,832) | "uncertain", lag=1 | false (0.005%) | Click on wallpaper, no app | All three honest, all agree |

### Decision matrix for the calling agent (validated by these trials)

```
algorithm_confident = (passesSinceLastVerification == 0) AND (finalDetectedPosition != null)
phase23_changed     = screenChanged

if !phase23_changed:
    → CLICK MISSED. Retry with corrected aim.
    Both trial-2-style failures and "click on wallpaper" cases land here.

if phase23_changed AND post_click_matches_expected_destination:
    → SUCCESS. Proceed.

if phase23_changed AND !post_click_matches_expected_destination:
    → WRONG TARGET. Back out (Cmd+H), then retry.
    Trial 1 lands here: click "succeeded" but on the wrong icon.
    The algorithm's "verified residual" is NOT trustworthy here.
```

The above algorithm is implementable at the calling-agent layer using
only the existing tools' return values. No further server changes
required to make this work — but Phase 23/24 must be DEPLOYED, which
they are not on the user's current MCP server (still pre-da3a434).

## ROOT CAUSE FOUND (2026-04-26): PiKVM streamer + iPadOS render latency ~235 ms

After the phantom-cursor finding (below), I instrumented a
`latency-probe` mode in `test-client.ts` that emits a known motion
(+200 X mickeys), then captures `/streamer/snapshot` at increasing
delays (0, 93, 235, 356, 500, 750, 1000, 1500, 2000 ms after the
HID emit).

Visually inspected the captured frames:

| Delay since emit | Cursor visible? |
|---|---|
| 0 ms | NO — frame identical to baseline |
| 93 ms | NO |
| 235 ms | YES — at (~785, 70) |
| 356 ms | YES — same position |
| 500 ms+ | YES |

**The PiKVM streamer's snapshot lags the actual screen by 150–235 ms.**
A screenshot taken sooner than that returns a frame from before the
HID was applied.

This explains every symptom in this troubleshooting log:
- `locateCursor` returning "0 raw clusters" — the before- and
  after-screenshots were both pre-emit frames, so the diff was
  empty.
- `detectMotion` returning "no post candidate" — same issue: the
  shotB grab returned a pre-emit frame, no cursor at the new
  position.
- Template-match false positives — when the screenshot has no
  cursor, NCC scores 0.95+ on whatever wallpaper texture happens
  to correlate with the cached templates' structure. Without a
  cursor in the frame, NCC is matching noise.

### The fix

Bump every `settleMs` (post-emit, pre-screenshot) from 150 ms to
300 ms — comfortably above the measured 235 ms threshold so the
streamer's next snapshot reflects post-emit reality. Locations:

- `cursor-detect.ts` `locateCursor.settleMs` default: 150 → 300
- `move-to.ts` `wakeupCursor` settleMs default: 150 → 300
- `move-to.ts` `discoverOrigin`'s locateCursor call: 120 → 300
- `move-to.ts` `postMoveSettleMs` default: 30 → 300 (this was the
  worst offender — 30 ms after open-loop emit guaranteed a pre-emit
  shotB)

Cost: ~250 ms × 4-7 screenshots = 1–2 s slower per moveTo. Worth it.

### Followup findings post-fix

After the latency fix landed, live test showed cursor IS now visible
in origin/calib/open-loop screenshots, AND `locateCursor` succeeded
for the first time on the iPad home screen — found a real pre/post
cluster pair at (850,301)→(938,301) for a +X probe.

Two remaining issues uncovered by the now-correct screenshots:

1. **iPad cursor cluster is just 4-7 bright pixels.** The original
   8-px `clusterMin` was rejecting real cursor clusters. Lowered to
   4. But the looser filter introduces more widget/animation noise
   into the candidate pool (post-candidates went from ~3 to ~13 in
   one trial), which then defeats the cluster-pair selection because
   too many candidates pass direction/sanity filters.

2. **Cached templates are poisoned.** Previous successful "captures"
   were saved while the algorithm thought the cursor was at FP
   wallpaper positions. Those templates now match wallpaper
   structures at score 0.999. Cleared `data/cursor-templates/` and
   `data/cursor-template.jpg` to force re-capture from a working
   detection run.

3. **Calibration probe still fails on Y-axis.** The +40 Y probe
   produces a real cursor pair, but with clusterMin=4 there are 13
   post-candidates and the right pair gets out-competed by widget
   noise. Likely fix: bigger calibration probe (100+ mickeys) so
   the cursor moves much further than any animation noise, giving
   pair selection a clearer signal. Or: piggyback on
   `locateCursor`'s already-measured `probeOffsetPx` to skip the
   redundant calibration probe entirely.

### Phase 15 — separate Y calibration when Y-dominant

Phase 14 set `calibratedRatioY = ratioFromXProbe` (assumed
symmetric). Live data showed iPad pointer acceleration is per-axis
AND per-direction — X probe gave 0.85, but actual X-direction in
the opposite movement was 0.076 (12× different); Y ratio was 2.04
when X was 0.85 in the same trial.

Phase 15 lets the calibration probe still run when the move is
Y-dominant — only skip it when the X-probe-axis matches the
warmup-axis. Live verified Phase 15 measures both ratios cleanly:
X 0.85 from locateCursor probe + Y 0.811 from calibration probe.

### Phase 22 — progressiveOpenLoop reproducibility check (0/5 hit)

After Phase 22 commit, ran 5 click trials at Settings (1027, 825)
in progressive mode. Algorithm reported residuals of (41, 139) =
145 px in 4 of 5 trials — an identical "stuck" position
suggesting template-match was recovering at a stable FP at
(1068, 964), not the real cursor.

Visually inspected the post-click screenshot of trial 1: cursor
landed at ~(1080, 800), top-right of Settings icon, just
outside the hit area. None of the 5 trials opened Settings.

So the earlier 34.8 px progressive trials were measured against
an unreliable internal tracking — the algorithm thought the
cursor was close to target while it was actually at a
predictable FP location, and ALSO the visible cursor at
~(1080, 800) was just outside the icon hit area regardless.

Phase 22's progressive mode is real architectural improvement on
the planning math, but the click-on-icon failure rate hasn't
changed. The remaining issue isn't planning — it's that:
1. iPad icon hit areas are tighter than our typical 35-50 px
   residual band.
2. Algorithm's `finalDetectedPosition` doesn't always match the
   cursor's true position when template-FPs are involved.

The honest fix path is at the MCP-tool layer: click + post-click
screenshot diff + retry. Continue clicking until the screen
visibly changes (app launched / modal popped), or surface the
unreliability to the caller.

### Phase 22 — progressiveOpenLoop (opt-in wake-emit-verify)

Phase 17 attempted "zero out the open-loop, let the correction
loop carry the move" before Phases 20-21 were in place. Live
test then showed worse results because correction-pass
motion-diff was failing silently and 5+ blind passes compounded
error.

With Phase 20's tighter template-FP rejection and Phase 21's
looser ratio sanity bounds, retried the architectural change as
opt-in `progressiveOpenLoop` option (default false; user picks
in via test-client moveto/click third arg `progressive`).

Live data, click(1027, 825) target on iPad home screen:

| Mode | Trial | Residual | Settings opened? |
|------|-------|----------|------------------|
| Default (single-shot) | 1 | 96.8 px | NO |
| Default (single-shot) | 2 | (n/a) | NO |
| Default (single-shot) | 3 | (n/a) | NO |
| Progressive | 1 | 141.2 px | NO |
| Progressive | 2 | **34.8 px** | NO (just outside) |
| Progressive | 3 | 96.8 px | NO |
| Progressive | 4 (click) | 35.1 px | NO (cursor at edge of icon) |

Progressive's BEST trials (34.8, 35.1 px) are noticeably tighter
than default's (96, 141, 178 px). The cursor on those trials
landed just outside the icon hit area — visually inspecting the
post-click screenshots showed the cursor at (985, 855) when the
icon's left edge is around X=990.

So Phase 22 is real measurable improvement on the planning
accuracy, but click-on-icon reliability still requires either:
1. Hitting the centre of the icon (within ~30 px) — possible
   with progressive but not consistent.
2. Larger hit areas — out of our control on iPad.
3. Click-and-verify-result wrapper at the MCP layer.

Kept as opt-in default-false because it adds latency (more
correction passes) and isn't strictly better than single-shot
when single-shot happens to luck into a close residual.

### Phase 21 reproducibility — 1/4 success rate

Marked Phase 21 as "END-TO-END SUCCESS" too early based on a
single trial. Subsequent reproducibility check on the home screen
ran 3 more trials at the same target (1027, 825):

| Trial | Open-loop ratio measured | Final cursor | Settings opened? |
|---|---|---|---|
| First (the "success") | (not captured) | (1023, 833) approx | YES |
| Trial 1 | 4.607 | (1004, 731) | NO |
| Trial 2 | 5.152 | (1168, 836) | NO |
| Trial 3 | 0.561 | (966, 808) | NO |

**Open-loop ratio variance across 3 consecutive identical
commands: 0.56–5.15, a 9× spread.** Same iPad, same target,
same code path — iPadOS's pointer acceleration is genuinely
non-deterministic at this magnitude.

Phase 21's looser sanity range (admit ratios up to 6) lets the
algorithm record what it's measuring instead of rejecting some
trials' pairs. That's more honest reporting but it doesn't
change the fundamental problem: with 9× ratio variance, single-
shot planning + a few correction passes can't converge to <30 px
residual.

The **only way forward** that the data supports is to make each
correction pass close the loop incrementally with verification
between every emit — and even that has to handle the per-pass
motion-diff failures we've documented elsewhere. The session's
phases addressed the foundation (latency, cluster filter,
calibration source, FP rejection); they don't change the iPad
acceleration randomness that makes click-on-target a stochastic
process.

### Phase 21 — bumped detectMotion ratio sanity max from 4 to 6

`detectMotion`'s pair-selection rejected any candidate pair whose
implied px/mickey ratio was outside [0.3, 4]. Live ballistics
data (Phase 18) showed iPad Y-axis ratios up to 5.7 and X up to
4.3 in some bursts. The 4× upper bound was rejecting legitimate
cursor pairs — leaving the algorithm to fall back to template-FP
recovery, which Phase 20's tighter threshold then correctly
refused, resulting in honest-but-blind clicks.

Bumped to [0.3, 6]. Live verification: click(1027, 825) target
**actually opened Settings** — first end-to-end success in
multiple sessions of patching. The post-click screenshot shows
Settings → SumUp Payment permissions page (resumed from prior
state). Cursor visibly at ~(1023, 833) — landed on the Settings
icon's hit area.

The compound effect of every fix in this session lined up:
- Phase 13 latency fix: cursor visible in screenshots
- Phase 14b: locateCursor cluster filter matches cursor size
- Phase 19: locateCursor primary, calibration fires
- Phase 20: correction-pass template-match too strict at 0.83
- Phase 21: motion-diff sanity range admits real cursor pairs

Each was necessary; none alone was sufficient.

### Phase 20 — tighter correction-pass template-match threshold

Default `findCursorByTemplateSet` minScore is 0.83. Live data
showed correction-pass template-match returns FPs at score
0.92-0.99 on iPad UI elements (clock area, icon corners). When
those FPs were trusted as cursor recovery after motion-diff
failed, `currentPos` got poisoned and the next correction emitted
in the wrong direction.

Phase 20 raises the threshold to 0.95 specifically for the
correction-pass fallback (open-loop and origin discovery keep
the looser default since they don't have a confirmed prior
position to anchor against). Below 0.95 → null → trust
prediction → circuit breaker fires after 2 predicted passes.

Live trade-off observed:
- Pre-Phase-20: 7+ correction passes, 7/7 used template
  recovery, residual reported 550 px (visible 180 px miss).
- Post-Phase-20: 1 correction pass, then template-match fell
  below threshold → null → predicted-residual exit. Visible
  residual ~130 px.

Smaller residual visually but the algorithm's "Final cursor"
report is now from PREDICTION, not detection — `finalDetectedPosition`
is null in this trial. The algorithm is more honest about its
uncertainty (good) but still doesn't know where the cursor
really is when motion-diff fails. Threshold-only doesn't solve
the underlying detection blindness — it just prevents one
specific failure mode (FP poisoning currentPos).

### Phase 19 — locateCursor PRIMARY for origin (template-match fallback)

The pre-Phase-19 ordering put template-match first and only used
locateCursor as fallback. With the latency fix (Phase 13) in
place, locateCursor is now reliable on the iPad — and crucially,
it's the only origin path that produces `probeMeasurement` for
Phase 14 to use as live calibration. Template-match-as-origin
silently skipped Phase 14, leaving planning to use profile
defaults (3.04, 5.28 X/Y) that are 4-6× off the actual iPad
ratios in this context.

Live trace 2026-04-26 click(1027, 825):
- Pre-Phase-19: template-match origin → no Phase 14 → planRatio
  (3.0, 3.72) → emit (-14, -3) → cursor landed 154 px east of
  target.
- Post-Phase-19: locateCursor primary → Phase 14 FIRES,
  `CALIBRATION X ratio from probe: 1.317` → emit (-204, -19) →
  open-loop residual to predicted is small but motion-diff
  failed and template-match returned FPs that confused the
  correction loop. Visible final residual ~180 px.

The Phase 14 calibration is now correct. The residual is shifted
to a different bottleneck: when motion-diff fails between
correction passes (which still happens on busy iPad frames), the
template-match recovery picks FPs and currentPos drifts. The
Phase 11 locality-aware ranking helps but isn't sufficient when
the prior position is itself a tracking error.

Template-match remains as a fallback when locateCursor fails
(returns null after maxAttempts). This preserves availability
without giving up the calibration data when probe-based origin
succeeds.

### Phase 18 — fresh ballistics profile (data, not code)

The pre-existing `data/ballistics.json` was captured 2026-04-23
when the latency-fix was not yet in place: screenshots were
returning pre-emit frames, motion-diff failed silently, only a
few samples at magnitude 127 were accepted. Result: a single-
magnitude profile with X=2.0–3.2 px/mickey, Y=5.7 px/mickey.

Re-ran `measureBallistics` (full sweep, callsPerCell=5) with the
latency-fix in place. The new profile has clean medians at every
magnitude:

```
'x:slow:5':   12.4   'y:slow:5':   --   (rejected at this size)
'x:slow:10':  5.96   'y:slow:10':  --
'x:slow:20':  3.0    'y:slow:20':  --
'x:slow:40':  1.49   'y:slow:40':  3.72
'x:slow:80':  0.75   'y:slow:80':  1.84
'x:slow:127': 0.49   'y:slow:127': 1.02
```

**Per-call displacement is ~60 px regardless of magnitude.**
Mag×ratio is constant: 5×12.4≈10×5.96≈20×3.0≈40×1.5≈80×0.75≈127×0.49 ≈ 60 px.

That tells us iPadOS doesn't really "accelerate" — it caps the
per-HID-call cursor displacement to ~60 px. Multiple HID calls
accumulate (10 calls of 5 mickeys each ≈ 600 px), but a single
giant emit still only moves ~60 px per call.

Implication for the existing code: the per-chunk ratio at
`chunkMag` IS the right lookup, and the existing
`lookupPxPerMickey(profile, axis, chunkMag, 'slow')` is correct.
What's wrong is when callers forget to chunk — then a single-
emit big magnitude only moves ~60 px and the cursor "lags". The
chunk loop (`emitChunked`) already handles this.

But there's a wrinkle: the per-call displacement of ~60 px is
**callsPerCell × pace dependent**. With `callsPerCell=5` at
`paceMs=30` (the profile's measurement regime), each call = 60 px.
At a different pace or different number of consecutive calls,
displacement per call changes.

**Phase 18 attempted a fixed-point lookup helper** that would
plan total mickeys based on planned-magnitude ratio. This was
misguided — the existing per-chunk lookup at chunkMag is already
correct. Helper deleted, revert clean.

The real next step is verifying the chunked-emit really produces
the expected cumulative displacement at moveToPixel's
chunkMag/chunkPaceMs settings. The profile's measurement regime
(callsPerCell=5, pace=30ms) closely matches Phase 16's defaults
(chunkMag=20, chunkPaceMs=30ms), so they should agree — but a
direct A/B test would confirm.

### Phase 17 — capping open-loop burst (REVERTED)

The Phase 16 doc said the next architectural step is wake-emit-
verify: each chunk's emit stays in the slow regime that matches
calibration. Phase 17 implemented this by capping the open-loop
burst to 25 mickeys/axis and bumping the correction-pass budget
to 12, expecting the correction loop to do the bulk of the move
via multiple small verifiable chunks.

**Live result was worse, not better**: residual went 152 (Phase
16) → 506 (Phase 17). The reason is more passes means more chances
for motion-diff to pick a wrong cluster pair on a noisy frame.
One bad pair update sends `currentPos` to the wrong place; the
next correction emits in the wrong direction; circuit breaker
fires; final residual is huge.

**Reverted Phase 17.** The open-loop burst goes back to clamp-only
(no per-axis cap), and `maxCorrectionPasses` back to 5.

The real lesson: **fewer-but-more-correct passes beat more-but-
noisier passes**. Wake-emit-verify only works if each verify step
is reliable. With the iPad home screen's widget noise + the small
cursor cluster (4-7 px), motion-diff's pair selection is
noticeably more error-prone than the open-loop's bulk-displacement
detection. The bulk move covers more pixels per emit, which
correlates the cursor cluster pair more strongly than animation
clusters that move only a few pixels per second.

The right path forward is therefore **not** more correction
passes. It's making each correction pass more reliable. Concrete
next steps:
- Per-pass micro-probe before correction emit: small +X bump (10
  mickeys), screenshot, diff to confirm cursor's actual current
  position before planning the corrective emit. Cost: extra
  screenshot per pass. Benefit: prevents cluster-pair-confusion
  from poisoning `currentPos`.
- Or adopt an entirely different detection strategy on busy
  frames — e.g. iPadOS Live Caption / Voice Control accessibility
  surfaces, mouse position via remote-debug protocol if iPad
  exposes one, screen-recording the iPad and reading cursor from
  recording metadata.

### Phase 16 — slower open-loop chunks

After Phase 15, calibrations were measuring (X=0.817, Y=1.961) but
the open-loop motion-diff observed live ratio 3.572. Same context,
same direction — different ratios because iPadOS pointer
acceleration is **velocity-dependent**: slow probes (40 mickey at
30 ms pace) get a low ratio, fast bursts (60 mickey at 20 ms pace)
get a higher one.

Slowed open-loop default chunk to chunkMag=20 / chunkPaceMs=30 (was
60/20). Live: residual dropped from 265 px to 152 px. Still not
matching calibration ratio because iPadOS acceleration depends on
TOTAL emitted distance per pointer-event-burst, not just per-chunk
velocity — a 184-mickey emit at 20-mickey chunks still hits the
acceleration curve harder than a 40-mickey calibration probe.

This is a fundamental iPadOS limitation: a single px/mickey ratio
cannot describe the system. The next architectural step is "wake-
emit-verify" — emit a small chunk (≤30 mickeys), measure the
actual displacement via motion-diff, plan the NEXT chunk based on
that observed ratio. Each chunk's emit stays in the slow regime
that matches calibration.

### Phase 14 — locateCursor probe doubles as calibration

Implemented option 2 above. `LocateCursorResult` now exposes
`probeMickeys` (signed mickey count of the successful probe).
`discoverOrigin` returns this through to `moveToPixel`, which uses
it to seed `calibratedRatioX`/`Y` and skips the separate
calibration probe entirely. Saves one screenshot (~250 ms) and
removes the noise-prone Y-axis calibration step that was failing
in step 3 above.

The architectural shape is now:
- `locateCursor` — does origin discovery AND ratio measurement in
  one probe-and-diff pass.
- `moveToPixel` — uses the measured ratio to plan open-loop;
  refines via correction-pass motion-diff if available.

When `locateCursor` fails (the diff didn't surface a +X cursor
pair, e.g. on a very busy frame), the fallback path still runs the
classical calibration probe — but with `forbidSlamFallback=true`
on iPad, `locateCursor` failure is now a hard throw rather than a
silent slam-fallback corrupting the iPad. This is the right
honesty-vs-availability trade-off.

## CRITICAL FINDING (2026-04-26): the algorithm has been clicking on phantom cursors

After actually saving and looking at every intermediate screenshot
in `moveToPixel`'s pipeline, the truth came out:

- **Frame 00 (origin-shot-postWakeup)**: no cursor visible anywhere.
  Algorithm claimed cursor at (1056, 836) with template-match
  score **0.958**. The score is a false positive on the iPad's
  blue/teal wallpaper texture — there is no cursor in the frame.
- **Frame 02 (shotA-postCalib)**: still no cursor visible. The
  -40 X calibration probe did emit, and `detectMotion` reported
  "calibration probe diff failed: no pair passed direction/sanity
  filters". That failure was honest — there was no cursor pair
  to find because the cursor was not rendered.
- **Frame 03 (shotB-postOpenLoop)**: still no cursor visible.
  Algorithm continued to use FP template-match positions.
- **Frame 04 (after several correction passes)**: cursor finally
  visible — at **(832, 90)**, top-center of the screen, just to
  the right of the "01.13" time display. This is approximately
  730 px LEFT and 740 px UP from where the algorithm thought it
  was.

So every "residual = 32 px" success and "residual = 178 px"
near-miss reported in this troubleshooting log so far is wrong.
The algorithm has been driving a cursor it cannot see, while
template-match against the cached templates has been finding 0.9+
score peaks on wallpaper-texture regions and reporting those as
the cursor's location.

### What this means for the patch series

Phases 1–12 were all reasoning from a self-reported cursor position
that was a phantom. Some of them helped detection IN CASES where the
cursor really was visible (e.g. immediately after a successful
probe), but none addressed the root cause: the algorithm trusts
template-match origin even when the cursor is not actually rendered.

### Why template-match scores 0.958 on no-cursor wallpaper

Cached cursor templates are 24×24 RGB crops captured against varied
backdrops. The iPad's home-screen wallpaper has high-contrast curves
between blue and teal regions. Some 24×24 windows in that wallpaper
correlate strongly with the templates' overall mean-and-variance
structure even though no cursor pixels are present. NCC normalises
out absolute brightness and gain, so a "shape" match at the right
scale wins regardless of content.

Ways forward (need design, not patches):
1. **Verify origin by emitted-motion confirmation, not score.**
   Emit a probe move; the cursor pre/post pair must appear in the
   diff with displacement matching the commanded direction. If the
   diff produces no plausible pair, the cursor is not visible and
   the algorithm must refuse to proceed (or do an extended wake
   sequence) instead of trusting a high-score template hit.
2. **Treat template-match score below 0.99 as untrusted for origin
   discovery.** A 0.83 default (or even the 0.89 of failed Phase 7)
   is far below the gap that separates real-cursor matches (live:
   0.91–0.97 over varied backdrops) from wallpaper-FP matches
   (live: 0.83–0.96). The score alone cannot distinguish them.
3. **Always run the cursor detection algorithm against a recently-
   moved cursor.** A "wake nudge" is necessary but not sufficient
   if the cursor takes longer than the settle time to render.
   Increase the settle, and require the post-wake screenshot to
   show *some* recent change relative to a pre-wake screenshot —
   if the diff is empty, cursor is not rendering, abort.

## End-to-end click verification (the bottom line)

Manual `click(1027, 825)` targeting the iPad Settings icon, post-Phase-12:

- Algorithm reports: `Final cursor at (1131,970); residual = 178 px`
- Post-click screenshot: **home screen unchanged — Settings did NOT open**
- The cursor landed 178 px past the icon onto wallpaper; clicking
  wallpaper does nothing.

This is the honest state: under current code, a click at a known
home-screen icon coordinate misses the icon roughly 50-80% of the
time (depending on the trial's correction-pass luck). The
architectural directions documented below are the path forward; the
patch series has reached the limit of what local fixes can deliver.

**Phase 23 update:** the verification side of "did the click land"
is now machine-checkable. `pikvm_mouse_click_at` returns a
`screenChanged: true|false` verdict based on a pre/post screenshot
diff. Above ~0.5% pixels differing in the full frame, the click
*did* trigger something on the screen; below that, it almost
certainly missed. This converts "miss" from an invisible failure
into an explicit signal the calling agent can branch on. It does
NOT improve hit rate — that still requires either centring within
~30 px of the icon or a higher-level retry policy that the calling
agent must implement.

## What we measured live

5-trial moveto sequence to (1027, 825) on the unlocked iPad home
screen, post-Phase-9:

| Trial | Residual |
|---|---|
| 1 | 32 px |
| 2 | 156 px |
| 3 | 224 px |
| 4 | 181 px |
| 5 | 275 px |

Variance is the dominant problem. A trial that hits all detection
paths cleanly lands at ~32 px (limited by HID 8-bit precision at the
smallest mickey count). A trial that drops into blind mode ends up
150–275 px off.

10-trial bench on home-screen scatter: 7–10 of 10 trials currently
throw `detect-then-move failed` because the cursor is genuinely
undetectable in the moment those screenshots are taken. With
`forbidSlamFallback=true` the failure is *visible* (an exception)
rather than silent (slam corrupts iPad via hot-corner gesture).

## Operator-side mitigations that already help

- **Disable iPadOS Pointer Animations** (Settings → Accessibility →
  Pointer Control → Animations). Reduces — but does not eliminate —
  cursor fade.
- **Keep iPad unlocked** while testing. The lock screen has no
  cursor and no animations; every detection path returns null on the
  lock screen, indistinguishable from a hard failure. The unlock
  skill (`pikvm_ipad_unlock`) is the recovery path.
- **Capture a few templates against varied backdrops** before
  benching. Phase 3's multi-template set grows naturally as
  successful moves persist new captures.

## The actual long-term answer

**The current architecture cannot reach single-digit residuals on a
busy iPad home screen** because every detection path bottoms out on
the same problem: cursor visibility in the captured frame. Every
"phase" we shipped is a workaround for one specific failure mode of
that root cause. The patches stack but don't compose into reliability.

Three directions worth designing properly:

### 1. Treat origin as a first-class probe, not template-match opt

Drop the template-match-as-origin shortcut. Every `moveToPixel` call
starts with a `locateCursor` probe-and-diff that *guarantees* a
freshly-detected cursor position. Cost: ~250 ms per call. Gain:
eliminates the stable-false-positive-as-origin failure mode entirely.
Template-match remains valuable as a *fallback* mid-correction when
motion-diff fails on a small linear pass — but never as primary.

### 2. Wake-emit-verify cycle, not chunked open-loop

The open-loop emission is the longest gap between captured frames.
Replace "emit all mickeys, then screenshot" with "emit ≤30 mickeys,
screenshot, verify, repeat". Each wake-emit-verify segment is short
enough that the cursor cannot fade in the middle. Cost: 4–8× more
screenshots per move. Gain: blind-mode is impossible because there
is no segment large enough to lose track.

### 3. Rebase residual-tolerance on confirmed detection

**Status (post-Phase 24): substantially closed via the honest-
reporting half; the exit-condition half is unnecessary.**

The original framing claimed "the message reports `residual 1.5 px`
even when `finalDetectedPosition` is null". On re-reading the code
that claim is inaccurate: the message-construction branch at
`move-to.ts` (the `if (finalDetectedPosition && finalResidualPx !==
null) { ... } else if (doCorrect) { ... 'Final position not
detected — click accuracy uncertain.' }`) already handles the null
case honestly.

The *real* dishonesty was a subtler one: when
`finalDetectedPosition` was non-null but had been set many passes
earlier, with intervening predicted passes, the message reported a
residual as if just verified. Phase 24 (commit `fd1bf55`) added the
`passesSinceLastVerification` field to `MoveToResult` and appends
"(last verified N pass(es) ago — N predicted passes since; cursor
may have drifted, accuracy uncertain)" to the message in that case.

Originally Direction 3 also proposed changing the loop exit
condition to require `mode: 'motion'` or `'template'` (i.e. forbid
early-exit on a small predicted residual). After Phase 24 this is
no longer worth doing:
- Forcing more correction passes when verification is failing does
  not make verification succeed (motion-diff struggles because the
  residual-correction emission is too small to form clusters above
  size threshold).
- The extra passes burn ~300–600 ms before the circuit breaker
  fires, with no improvement to `finalDetectedPosition`.
- The reported residual still derives from whichever pass last
  verified. Phase 24's qualifier already tells the operator how
  stale that is.

The remaining honest-reporting work (if any) belongs at the
calling-agent layer: the agent reading the MCP-tool message should
treat "(last verified N pass(es) ago)" as a soft-fail signal and
either re-aim or escalate, the same way it already treats Phase 23's
"Click did not trigger a visible screen change" verdict.

Direction 1 (always-locateCursor as origin, small) and Direction 2
(wake-emit-verify cycle, medium) remain on the architectural
roadmap; both want a deliberate refactor and have failure modes the
naive implementations hit (Phase 10 and Phase 17 respectively).

## What does NOT work, please don't try again

- **Tightening the origin template-match threshold without first
  fixing locateCursor.** Phase 7 did this and the bench failed 10/10.
  The threshold is symptomatic; the fix has to address why
  locateCursor returns null.
- **Slam-to-corner as a fallback on iPad.** It triggers iPadOS's
  hot-corner gesture and re-locks the screen. `forbidSlamFallback`
  is the right default for iPad targets.
- **A brightness floor that only checks frame B in a diff.** This
  silently drops the pre-cluster on dim wallpapers. Phase 8 corrects
  this; if you find yourself "simplifying" the brightness check back
  to one-frame, please re-read this paragraph first.
- **Capturing templates without `looksLikeCursor` validation.** A
  motion-diff pair selected wrong (e.g. icon corner) gets persisted
  as a "cursor" template, and then every subsequent template-match
  scores 0.99 against that same wrong spot. The validation gate
  exists; do not remove it.

## File pointers

- `src/pikvm/move-to.ts` — `moveToPixel`, `discoverOrigin`,
  `detectMotion`, the correction loop, all helpers.
- `src/pikvm/cursor-detect.ts` — `diffPixels`, `findClusters`,
  `mergeClusters`, `findCursorByTemplateDecoded`,
  `findCursorByTemplateSet`.
- `src/pikvm/template-set.ts` — directory-backed multi-template
  store, `loadTemplateSet`, `persistTemplate`, `migrateLegacyTemplate`.
- `src/pikvm/__tests__/cluster-color.test.ts`,
  `move-to.detectMotion.test.ts`, `template-set.test.ts` — the
  contract pins for everything above.
