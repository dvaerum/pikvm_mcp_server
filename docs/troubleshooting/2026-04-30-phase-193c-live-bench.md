# Phase 193-C live click bench (v0.5.186, 2026-04-30)

**TL;DR.** Detection layer is now honest after Phase 193-A/B
(brightnessFloor 170 → 100 + cursor-template wipe).
`screenChanged`-positive rate across 40 trials is **57 %**
(23/40); visual verification of 12 of those 23 "hits" shows
**only 1 actually opened the intended target** (Books trial 1).
Real correct-element-hit rate extrapolates to ~5–10 %.

The end-to-end click rate is bottlenecked **between
`moveToPixel` returning and the click event firing**: the
algorithm's reported residual is correct at moveToPixel exit,
but cursor drifts substantially before the click registers,
landing on adjacent icons or even triggering iPad gestures
(app switcher in Books trial 6). This is consistent with
Phase 111's "icon-sized targets ~50–60 % per attempt"
documented ceiling — but the visual data shows the *real*
ceiling is even lower than that, because most "hits" are
false positives from cursor-pixel motion across the verify
region.

## Setup

- Bench: `bench-click-extensive.ts 10` (10 trials × 4 small-icon
  targets = 40 clicks).
- Targets: Settings (905, 800), Books (640, 800), App Store (905,
  680), Files (1035, 420).
- Verify config: 100 × 100 px window centred on target,
  `minChangedFraction = 0.05`.
- `data/cursor-templates/` wiped before run so template-match
  starts honest (Phase 193-A finding: cached templates were
  matching the TV dock icon).
- iPad firmware / wallpaper / pointer-effect mode: as found,
  unchanged this session.

## Reported summary

```
Target                               | hit rate | first-hit attempts | median residual
-------------------------------------+----------+--------------------+------------------
Settings (small icon, badge)         |    70%   | 1:4 3:1 4:2        |         152px
Books (small icon)                   |    70%   | 1:2 2:2 3:1 4:2    |         143px
App Store (small icon)               |    70%   | 1:3 2:1 4:3        |         150px
Files (small icon, top-right)        |    20%   | 1:1 2:1            |         245px

Overall: 23/40 (57%)
```

## Visual verification of "hits"

| Target / Trial | Reported | Residual | Visual verdict |
|:---|:---|---:|:---|
| Settings 02 | HIT | 152 | **FALSE** — home screen, Settings did not open |
| Settings 04 | HIT | 521 | **FALSE** — home screen, cursor not visible |
| Settings 09 | HIT |  41 | **FALSE** — home screen, even at small residual |
| Books 01    | HIT | 101 | **TRUE** — "Welcome to Apple Books" splash |
| Books 03    | HIT | 208 | **FALSE** — home screen |
| Books 06    | MISS|  20 | (drift to bottom-edge → app switcher opened) |
| Books 08    | HIT |  25 | **FALSE** — home screen |
| Books 10    | HIT |  21 | **FALSE** — home screen |
| AppStore 01 | HIT | 147 | **FALSE** — Photos opened (wrong app, dock-icon hit) |
| AppStore 05 | HIT |  60 | **FALSE** — Books opened (wrong app) |
| Files 01    | HIT |  74 | **FALSE** — home screen |
| Files 02    | HIT |  35 | **FALSE** — Maps opened (wrong app) |

**1 / 12 visually inspected hits is a true correct-element-hit.**
The single success was Books trial 1 at residual 101 px.

## What "FALSE positive" means here

The bench's `screenChanged` metric uses a 100×100 px window
centred on target with a 5 % changed-fraction threshold. The
Phase 192-eval bench tightened this from full-frame in the
hope of filtering out clock / wallpaper noise. It does — but:

1. The cursor is a 7×11 px sprite that, when crossing the
   verify-region boundary between pre- and post-click frames,
   contributes ~0.5–2 % pixel change. Combined with badge
   flicker / sub-pixel anti-aliasing tweaks, that can squeak
   past the 5 % threshold without any actual UI launching.
2. When `moveToPixel` ends with the cursor on the icon and
   then drifts off (Phase 192-D unstick, micro-correction,
   pointer-effect repulsion), the cursor's *departure* from
   the verify region between pre and post causes a real
   pixel change — but the click went elsewhere.

The fix isn't more detection tuning. The fix is closing the
gap between "cursor is at target" and "click fires while
cursor is at target." That's a Phase 194 problem.

## What Phase 193 actually fixed

1. **`findClusters` no longer silently rejects the cursor.**
   With `brightnessFloor = 170` the dark iPad cursor (50–100
   brightness pixels at the cursor edge) was thrown away
   entirely; motion-diff returned no cursor pair. The new
   floor of 100 admits a 61-pixel cluster at the actual cursor
   position on every saved diagnostic frame
   (`data/detection-truth/*.jpg`).
2. **`findCursorByTemplateSet` no longer points at the TV
   icon.** Cached templates from historic bad captures (Phase
   119 regression) were scoring NCC ≥ 0.955 against the TV
   dock icon coordinate `(765, 786)` regardless of where the
   cursor really was. Wiping the cache restores honest
   behaviour: template-match returns null until clean
   templates re-seed during normal operation.
3. **Algorithm-reported residuals are now meaningful.** When
   the bench reports residual = 41 px, the cursor really was
   41 px from target *at the moment moveToPixel returned*.
   When it reports 521 px, the cursor really was far away.
   (The 521 px outlier on Settings trial 4 is likely an
   edge-clamp / clipping artefact in the belief module's
   predicted position; worth investigating in Phase 194.)
4. **Two regression tests pin the new defaults.** See
   `src/pikvm/__tests__/cursor-detect.test.ts § Phase 193:
   DEFAULT_DETECTION_CONFIG defaults`. If anyone tightens the
   floor back, CI fails with the Phase 193 context spelled
   out.

## What Phase 193 did NOT fix

- The end-to-end click pipeline is still bottlenecked at the
  iPadOS pointer-effect snap-zone level (Phase 111-117).
- For Files at top-right (1035, 420) the cursor lands at
  ~245 px residual on every retry — the bottom-row icons
  are far away, the page indicator dots are not in this
  region, but something is repulsing or mis-aiming
  consistently. Worth a focused investigation.
- The Books trial 6 case where cursor ends at the
  bottom-edge gesture zone (1023 y → app switcher opens)
  reveals that Phase 192-D's `belief.isAtEdge` unstick can
  push the cursor INTO the bottom-edge gesture trap on
  certain failure trajectories. **This is a regression risk
  worth a Phase 194-A fix.**

## Phase 194 candidate work

Listed in priority order — the user's standing instruction is
"the most import thing is to make the mouse click on the
correct coordinates." These are the highest-leverage paths:

1. **Pre-click pointer-effect dwell.** After `moveToPixel`,
   hover at the target for 300–500 ms (currently
   `preClickSettleMs = 80` ms) so iPadOS's magnetic snap
   captures the cursor onto the icon. Risk: free-time at
   target lets system auto-hide the cursor; combine with
   `keepCursorAlive`. Expected lift: meaningful, since
   most "near miss" residuals are 20–60 px which is well
   within the icon's snap radius.
2. **Adaptive verify region**. Compute the window as
   `target_region − last_known_cursor_region` so cursor-pixel
   drift across the boundary doesn't trip `screenChanged`.
   Eliminates the false-positive class entirely. (Hits would
   drop dramatically as a result, exposing the *real*
   correct-element-hit rate to the bench.)
3. **Phase 192-D unstick safety check.** Before emitting an
   unstick, verify the predicted post-unstick position is
   strictly inside `safeBounds` minus a generous edge margin
   (50 px). If not, suppress the unstick. Prevents the
   trial-6 bottom-edge-gesture trap.
4. **Files-target diagnosis.** The 245 px constant residual
   smells like a stuck belief / ratio mis-calibration on the
   path to top-right. Trace one Files trial frame-by-frame
   with belief instrumentation.
5. **Spotlight-launch escape hatch.** Already shipped as
   `pikvm_ipad_launch_app` (100 % reliable for known apps).
   Keep recommending this over click_at for small icons.
   (User has flagged this as documented, no further action.)

## Verifying the fix's narrow claim

Even though click rate didn't lift, the Phase 193 fix is still
correct. The narrow claim it makes:

> Detection no longer returns confident-wrong answers.

Verified by:

- `npm test` — 662/662 tests pass, including the new
  `Phase 193: DEFAULT_DETECTION_CONFIG defaults` regression
  test pinning `brightnessFloor === 100`.
- `bench-detection-truth.ts` — re-ran with the fix; cursor-sized
  cluster found at the actual cursor position on every trial.
  Diagnostic frames live in `data/detection-truth/`.
- `bench-findclusters-truth.ts` — saved-frame brightness sweep
  shows 0 clusters at floor=170, 1+ cluster at the real cursor
  position at floor=100.
- `nix build .#pikvm-mcp-server` — green; built
  `pikvm-mcp-server-0.5.186` derivation cleanly.

## Files referenced

- Bench script: `bench-click-extensive.ts`.
- Bench output: `data/click-bench/{settings,books,appstore,files}/NN-{hit,miss}.jpg`,
  `data/click-bench/results.jsonl`, `data/click-bench/summary` in
  `/tmp/bench-193c.log`.
- Detection diagnostic: `bench-detection-truth.ts` +
  `bench-findclusters-truth.ts`.
- Regression tests: `src/pikvm/__tests__/cursor-detect.test.ts`,
  `Phase 193: DEFAULT_DETECTION_CONFIG defaults` describe block.
