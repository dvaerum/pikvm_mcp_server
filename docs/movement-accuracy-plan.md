# iPad Cursor Movement-Accuracy Improvement — Plan & Progress Log

_Living doc. The `/loop 15m` (cron `9bd8e5c1`) updates the Progress Log each cycle._

## Problem statement

Detection is **solved** (V8/cursor-v13 reliably locates the cursor — 0% miss on
real UI, ~13 px vs ground truth). The remaining click failures are **movement**:
`moveToPixel` doesn't reliably land the cursor on the target pixel. Observed
2026-07-19 (15-target real-icon test): ~4/15 targets, the cursor drifts (often
toward the **dock / bottom**) or lands ~50 px off. The 25 px proximity gate now
turns these into *safe skips* (no wrong-app clicks) — but they're still non-hits.
**Goal: raise the correct-element hit rate by making the cursor actually reach
the target.**

## Be critical — why prior attempts failed (do not repeat)

- **pointer-accel-v2 / v3**: offline emit→displacement MLPs. v3's anti-overfit
  stack worked but the per-family weighting overshot. Offline MAE improvements
  **did not translate** to live click-rate.
- **1.11 "+55 pp pointer-accel lift"**: survived 6 fires before the 1.13c/1.14
  ground-truth bench walked it back — the "lift" was a **screenshot-detector
  artifact**, not a real gain.
- **Core lesson:** offline model metrics ≠ live click accuracy. The screenshot
  detector both drives and scores, so it can invent lifts. **Validate LIVE
  against iPadCollector ground truth.**
- **Noise floor:** ±10 pp at N=20; need paired difference + **N ≥ 80** to see a
  5 pp lift. Most sub-10 pp A/Bs are noise.
- **MPS↔CPU tensor subtraction silently returns garbage** (bit us on v12 eval) —
  co-locate operands if any training/eval happens.
- **Run newest code** — bench `src/` via `tsx`, not the deployed nix binary.

## Measurement protocol (ground truth FIRST)

iPadCollector is the key tool. For every landing, use **`getCursor`** (ground-truth
cursor px via the 3.5 affine → HDMI) — never the detector residual as truth.

Per move, record: `target`, open-loop predicted landing, each correction pass's
V8-detected landing, and the **final ground-truth landing** (`getCursor`). Also
compare V8-detected vs ground-truth to keep the detector honest.

- N ≥ 80 across **varied targets** (a grid, not just Books), **paired** (same
  targets across arms).
- Promote a change only if the **ground-truth residual** improves by **more than
  the noise floor** at N ≥ 80.

## Phases

### Phase 0 — Characterize the failure (measure, don't guess)  ← current
Move to a grid of ~8–10 varied targets × several reps. Record ground-truth
landing vs target. Output: distribution of final residual (ground truth),
**per-axis bias**, per-region pattern. Question to answer: is the drift a
**systematic bias** (e.g. Y-overshoot toward the dock) or **correction-loop
divergence / bail-to-bad-position**?

### Phase 1 — Diagnose root cause
Decompose the error from Phase 0: open-loop first-move error vs correction-loop
convergence. Is the pointer-accel model biased? Does the correction loop bail to
a worse position? Does the cursor drift *after* the move settles (pointer inertia)?

### Phase 2 — Fix (leading hypothesis: closed-loop on V8)
Now that V8 detection is reliable, rebuild the correction loop to close tightly
on V8: move → V8-detect residual → emit correction ∝ residual → repeat until
residual < gate or max passes. Prior correction leaned on motion-diff/template
(unreliable) so it couldn't converge. **Test: does closed-loop-on-V8 drive the
ground-truth residual < 25 px reliably?** Only pursue a better open-loop
pointer-accel model if closed-loop is insufficient AND the gain is validated live
(offline gains historically don't transfer).

### Phase 3 — Validate end-to-end
Real-icon click hit rate (like the 15-target test), ground-truth verified, gate
ON. Target: hit rate materially above today's baseline.

## Guardrails — self-check every cycle
- [ ] Measured with iPadCollector ground truth, not detector residual?
- [ ] N ≥ 80, paired, varied targets — not a small-sample verdict?
- [ ] Claimed lift > ±10 pp noise floor?
- [ ] Ran newest code (tsx on `src/`)?

## ⚠ HARD-LEARNED GUARDRAILS (read before touching the iPad)

- **DO NOT reboot the iPad to fix pointer/tracker state.** Cycle 2 tried it: the
  iPad came back with **HID offline + screen off + unreachable via devicectl**,
  and even a follow-up PiKVM reboot did NOT recover it (the iPad re-enumerates
  the USB gadget only when awake; a freshly-rebooted asleep iPad does not). Net
  result: a degraded iPad needing **physical** recovery. Reboots made it worse.
- **First action EVERY cycle:** health-check the iPad — screen on? HID online?
  `devicectl` responds? If NOT, the iPad needs physical recovery (power button /
  USB re-plug by the user) — notify and STOP the cycle. Do not reboot anything.
- The PointerTracker fix must be a **non-destructive** approach (app-side: verify
  iPadCollector's onContinuousHover wiring; or a cursor leave/re-enter of the
  SceneRendererView; NOT a reboot).

## Progress log

- **2026-07-19 (cycle 0):** Plan created. Baseline from the 15-target real-icon
  test: ~11/15 hit without gate; misses were movement failures (cursor drifted
  to dock / landed ~50 px off), not detection. Proximity gate (25 px) shipped
  → safe skips. Next: Phase 0 ground-truth characterization bench (varied grid,
  ground-truth landing vs target, per-axis bias). Prereqs: tinyproxy:8888 up;
  iPadCollector must be relaunched (it was terminated after the click test).

- **2026-07-19 (cycle 0, cont.):** ⚠ Phase 0 sweep (4 targets × 8 trials) FAILED
  — all 4 runs aborted with `iPadCollector connected but its PointerTracker
  never fired hover events after 8 wake attempts`. Diagnosed live: after the
  move-to-centre wake, the PiKVM screenshot shows the cursor as an **I-beam**
  (text-cursor) near the RIGHT edge of the iPad content (~1290,880), NOT an
  arrow over a scene. An I-beam means the pointer is over a **text field** — so
  iPadCollector is presenting its **settings / reconnect screen** (URL text
  field), not the `SceneRendererView`, so `UIHoverGestureRecognizer` → tracker
  never fires. Root-cause hypotheses for next cycle, in order:
    1. iPadCollector is stuck on the settings/URL sheet or the "Lost connection"
       reconnect screen (it lost the WS server between runs) — dismiss it
       (Escape / tap) or ensure it lands on the SceneRendererView after launch.
    2. The fresh signed reinstall today may have reset the persisted WS URL —
       reconfigure via the `help` keyboard shortcut → ws://10.109.1.251:8767.
    3. `slamThenCenter` may be depositing the cursor at the content edge /
       letterbox rather than centre → verify with detectIpadBounds and adjust.
  **Do NOT run the movement A/B until awaitPointerAlive succeeds** — otherwise
  every ipad_x/ipad_y row is empty and the "measurement" is worthless (this is
  exactly the stale-getCursor failure the roadmap warned about). No movement
  data collected this cycle; blocker is the ground-truth harness, not the mover.

- **2026-07-19 (cycle 1):** Root-caused the harness blocker. iPadCollector
  **connects fine** (hello 820×1180) and **renders scenes fine** (showScene(gray)
  → gray portrait region confirmed in a PiKVM screenshot; cursor visible as an
  arrow OVER the scene). The failure is isolated: the app's **PointerTracker is
  dead** — raw `getCursor()` returns `{x:0, y:0, tracked:false}` on every poll,
  under vigorous continuous movement, a tap-to-focus, AND an Escape. The app is
  alive (t_ipad timestamps update); only hover tracking is stuck off. It WORKED
  during the earlier bench runs (v13/v12-conf got real tracked positions) → this
  is a **state regression** introduced during the click-test session (repeated
  terminate/relaunch + app-switching), not a code bug in the app or the mover.
  App-level nudges/tap/Escape do NOT recover it.
  **NEXT-CYCLE ACTION (do this first):** reset the iPad pointer/HID state with
  `xcrun devicectl device reboot --device CF2B815D-7960-5B60-987B-FA2DC9A65353`
  (confirmed available). Then: wait ~60–90 s for boot, wake/unlock the iPad
  (sendKey Enter), relaunch iPadCollector, and **re-verify `getCursor` returns
  `tracked:true`** with a short poll BEFORE doing anything else. Only once
  tracking is live, run the Phase 0 varied-target sweep. If a reboot does NOT
  restore tracking, investigate iPad pointer/AssistiveTouch settings and the
  app's onContinuousHover wiring (the tracker may need onHover(false)→(true)
  re-arming, which a full-screen SceneRendererView never gets). Still zero
  movement data — correctly refusing to fabricate it.

- **2026-07-19 (cycle 2):** ✗ SETBACK. Tried the cheap fix first (HID reset to
  re-init hover) — did not restore tracking (0/10). Then executed the plan's
  reboot fix (`devicectl device reboot`). **It backfired:** the iPad came back
  with HID offline, screen off, and unreachable via devicectl; HID reset +
  reconnect didn't help; a PiKVM reboot (which recovered HID earlier when the
  iPad was awake) also did NOT recover it this time. Stopped escalating after
  two reboots — further reboots would be thrashing. iPad is now in a degraded
  state requiring **physical intervention** (power button / USB re-plug).
  Notified the user. Added the HARD-LEARNED GUARDRAILS above. Still zero
  movement data; net-negative cycle (made the environment worse, honestly).
  **Next cycle:** health-check the iPad first; if not recovered, notify + stop;
  once recovered, pursue a NON-destructive PointerTracker fix (never reboot).

- **2026-07-19 (cycles 3–4):** iPad health check both cycles → still degraded
  (HID offline, screen off, devicectl unreachable). No-op by design (guardrail).
  After 2 consecutive skips with the blocker being a PHYSICAL user action, the
  `/loop 15m` (cron 9bd8e5c1) was **paused** (CronDelete) to avoid firing
  uselessly every 15 min. **To resume:** physically recover the iPad (power
  button / USB re-plug), confirm screen ON + HID online, then re-run
  `/loop 15m <the movement prompt>`. First real action next time: a
  NON-destructive PointerTracker fix (never a reboot), then the Phase 0 sweep.

- **2026-07-20 (loop re-armed, cron af10fb06):** Environment recovered (the
  cycle-2 iPad reboot + a user-initiated PiKVM reboot fixed HID; harness recovery
  fully documented in docs/troubleshooting/2026-07-20-ipad-hid-offline-usb-recovery.md).
  **The PointerTracker bug is GONE** — the iPad reboot cleared the stuck hover
  state: `getCursor` now returns `tracked:true` 10/10 with real coords
  (verified this cycle). So iPadCollector ground truth is live again. Health
  check clean (screenshot OK, connected 820×1180). **Launched the Phase 0
  varied-target sweep** (bench-4.3 for Files/AppStore/Settings/Books, 8 trials
  each) in the background — the first REAL movement-accuracy data. Next cycle:
  analyze per-target ground-truth residual + per-axis bias to answer
  systematic-bias vs correction-divergence.

- **2026-07-20 (Phase 0 RESULTS — first real data, N=128, 0% null):** Ground-truth
  residual (getCursor vs target): median **19px**, p90 **71px**, max 123px.
  Per-axis bias: dx **−12.5px**, dy **−26.7px** (negative = cursor lands
  above/left of target = UNDERSHOOT). dy undershoot GROWS with target distance:
  Files(top) −11 → Books(bottom) −42; Books p90 96px is the worst region.
  DIAGNOSIS (Phase 1 answered): it's a **systematic undershoot (up-left, scaling
  with distance)**, NOT correction divergence, and NOT "drift toward the dock" —
  the earlier eyeballed "toward the dock" claim is REFUTED by ground truth (the
  cursor lands above, not below). The misses come from the **TAIL** (p90 71px),
  not the median. Two error sources: (a) systematic undershoot ≈ correction loop
  leaving residual — likely minResidualPx=25 early-exit + open-loop under-emit on
  far targets; (b) a fat tail = occasional large errors = the real miss source.
  Caveat: measured on iPadCollector's black surface (NO icon magnetism, which in
  real UI snaps the cursor onto icons and helps) — so this is a clean MODEL-error
  measure and a pessimistic proxy for live hit-rate.
  **PHASE 2 PLAN (next):** rebuild the correction tail as closed-loop-on-V8 —
  iterate move→V8-detect-residual→emit-correction until GT/V8 residual < a TIGHT
  gate (e.g. 12px) on EVERY attempt, killing the p90 tail; and add a
  distance-aware / bias-corrected emit so the open-loop first move doesn't
  undershoot far targets. Re-measure at N≥80 paired vs THIS baseline (median 19 /
  p90 71); promote only if GT residual beats it by > the ±10pp/noise floor.
