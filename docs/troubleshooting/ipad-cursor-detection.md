# iPad cursor detection — troubleshooting log

This document captures what we learned debugging the iPad
`pikvm_mouse_click_at` accuracy problem on real hardware, what worked,
what didn't, and the long-term direction. Written so the next person
who touches `move-to.ts` doesn't have to re-derive everything from
commit messages.

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

Today the correction loop exits when the *predicted* residual is
below tolerance. That's why the message reports `residual 1.5 px`
even when `finalDetectedPosition` is null. Change the exit condition
to require a *verified* residual ≤ tolerance — i.e. the last pass
must be `mode: 'motion'` or `mode: 'template'`, not `'predicted'`.
A trial that ends without verification reports honest "click
accuracy uncertain" rather than fake success.

Direction 1 is small, direction 2 is medium, direction 3 is small
but changes user-visible semantics. All three together would replace
the current correction loop with a fundamentally more reliable
design. None of them is appropriate to slot in as a "Phase N+1"
patch — they want a deliberate refactor.

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
