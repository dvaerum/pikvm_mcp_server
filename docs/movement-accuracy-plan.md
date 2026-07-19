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
  CORRECTION: an earlier version of this note claimed the iPad home screen has
  "icon snap-assist / magnetism" that pulls the cursor onto icons. That is FALSE
  and was never a thing on iPad — there is no such behavior. Do not attribute any
  live hit-rate difference to it. The black-surface measurement is simply a clean
  model-error measure; the target pixel must be hit on its own.
  **PHASE 2 PLAN (superseded — see Phase 2 RESULTS below):** rebuild correction
  as a closed-loop on ground truth / V8, tight gate, adaptive gain.

- **2026-07-20 (Phase 2 RESULTS — closed-loop-on-GROUND-TRUTH, N=24 CHARACTER-
  IZATION, not a verdict):** scratch/closed-loop-gt.ts corrects using
  getTrackedCursor (mapped to HDMI) as the ONLY feedback — no visual detector in
  the loop (per user directive: use iPadCollector as the closed-loop feedback,
  not just a scorer). Adaptive px/mickey gain, 6px gate, ≤10 passes.
  Aggregate: median **10px**, p90 **29px**, 83% within 25px (vs Phase 0
  detector-corrected median 19 / p90 71). DO NOT credit "better feedback" — the
  gap conflates feedback + a tighter loop (6px gate vs 25px early-exit, more
  passes, adaptive gain); since the detector already ≈ ground truth to 11px, the
  loop-design change is likely the bigger factor. Not separable at N=24.
  **STRUCTURAL FINDING (trace-proven, NOT a hypothesis):** the loop converges
  fast to ~25px then STALLS at the emit floor — 58% of attempts floor-stall.
  Traces: `Files a2 [465,296,141,21,24]` (reached 21, sub-floor correction
  swallowed → ended 24); `Files a1 [457,288,132,26,103,51,18]` (reached 26, a
  coarse 25-mickey step OVERSHOT to 103, oscillated). This is the documented
  ~25-mickey emit floor (PA38 / [[project_ipad_emit_thresholds]]): a minimum
  registering relative move ≈ ~25px of travel, so the loop cannot make sub-25px
  corrections. **The bottleneck is EMIT GRANULARITY, not feedback or detection**
  — ground-truth feedback barely helps once the floor is 25px. So closed-loop is
  necessary but NOT sufficient; it plateaus at the floor.
  **ABSOLUTE MOUSE MODE = DEAD END (verified live 2026-07-20).** getHidProfile()
  reports `mouseAbsolute:false` — the iPad is a relative-only HID host (as the
  client comment at client.ts:811 already warned). This is WHY the whole
  ballistics/pointer-accel edifice exists. Pursuing absolute mode would mean
  reconfiguring PiKVM's USB gadget (risky — cf. the kvmd-otg trap) with low odds
  iPadOS accepts absolute positioning (it treats mice as relative/trackpad). Not
  the path. Verified, not assumed.
  **PHASE 3 PLAN (revised, next):** the ~25px emit floor is a HARD FLOOR in
  relative mode — accept it. For icon-sized targets (>50px) landing within ~25px
  of center is already a HIT, so the floor is fine; the real win is KILLING THE
  p90 TAIL (Phase 0 p90 71px, max 123px → the closed-loop's better design got p90
  to 29). Action: port the improved loop design (tight gate, adaptive per-axis
  gain, more passes, NO premature 25px early-exit) into production moveToPixel,
  correcting on the VISUAL DETECTOR (production-available; ≈ ground truth to
  11px). Expected: production median ~19→~15 and p90 71→~30, bounded by the floor.
  Validate LIVE at N≥80 paired vs Phase 0 baseline (median 19 / p90 71); promote
  only if the p90 tail improves beyond the noise floor. This is built on THIS
  session's evidence, not an offline model claim.
  **^ THE ABOVE PHASE 3 PREMISE ("25px hard floor") IS WRONG — see below.**

- **2026-07-20 (Phase 3 RESULTS — the "25px floor" was a FALSE assumption;
  micro-stepping hits <5px):** Two experiments overturned last cycle's premise.
  (1) fine-emit-probe.ts — measured the real emit→displacement curve vs getCursor
  (5 reps, isolated emit + 250ms settle): 5mick→2.4px, 8→4.9px, 12→8.2px,
  16→11.5px, 20→14.9px, 25→19px. **NO sub-threshold floor**, perfectly
  deterministic (identical to 0.1px across reps). The old PA38 "25-mickey floor /
  ≤20=0px" was a v11-DETECTOR resolution artifact (couldn't resolve sub-15px
  moves) — corrected in [[project_ipad_emit_thresholds]]. And last cycle's
  "plateaus at ~25px floor" was ALSO false: it was my own hard-coded EMIT_FLOOR=25
  skip giving up, not the iPad.
  (2) closed-loop-v2.ts — micro-step on that curve, undershoot 15%/step, settle
  between steps, no floor. Scored on getCursor, N=24: median **2.8px**, p90
  **3.4px**, max 4.7px, **100% within 5px**, 4–5 passes, ZERO overshoot (traces
  descend monotonically, e.g. Books [360,209,57,13,2]). vs v1 median 10/p90 29 vs
  Phase 0 median 19/p90 71.
  HONEST CAVEATS: (a) N=24 is below the marginal-verdict noise floor, but the
  effect is huge+deterministic; the open question is production, not
  significance. (b) Uses getCursor feedback, which production does NOT have —
  production uses the visual detector (~11px noise), so a production micro-stepper
  floors near ~11px, NOT 2.8px. Do NOT quote 2.8px as production. The PORTABLE win
  is curve-based micro-stepping that never overshoots — kills the p90 tail
  regardless of feedback source.
  **PHASE 4 PLAN (superseded by Phase 3.5 below).**

- **2026-07-20 (Phase 3.5 — ONE-GO open-loop is accurate & deterministic; user
  asked "precision over different distances in one go"):** Two probes.
  KEY HID FACT: mouseMoveRelative clamps every delta to ±127 (int8, one HID
  report); long moves = a burst of reports.
  (1) wide-emit-probe.ts — single-report curve is DETERMINISTIC (std 0.0) and
  nonlinear across the full range: M=20→14.9px, 40→48.6, 60→89, 80→119.6,
  100→135.6, 127→157.3 (px/mick 0.74→peak 1.49→1.24). Bursts are deterministic
  AND LINEAR: each 127-report adds exactly 157.3px, std 0.0, NO loss — which also
  refutes PA38's "30% burst coalescing" (another detector artifact).
  (2) one-go-confirm.ts — planning one open-loop shot from the measured curve
  (full 157px-reports + one partial), landing error over distance (N=4 each):
  D=50→0.6px, 100→3.5, 200→-2.3, 300→0.1, 450→0.1 — all ≤3.5px, std 0.0.
  Position-independent: D=200 from 3 vertical starts → 197.7px identical.
  CONCLUSION: the emit→displacement transfer function is a fixed, invertible,
  position-independent nonlinear curve; ONE open-loop shot hits any distance
  (50–450px) to ~3.5px. This overturns the project's "open-loop doesn't work"
  history — prior failures measured with the DETECTOR (too noisy to see the true
  response) → the overshoot/floor/coalescing folklore.
  CAVEATS: +X only, N=4/distance, one session. NOT yet confirmed on -X/±Y (curve
  may be per-axis — HDMI map alone is 0.83 px/logical on X vs 0.80 on Y) or on a
  diagonal 2D target. And the 3.5px is EMIT accuracy: production learns the start
  position from the detector (~11px), so a production one-shot lands ~√(3.5²+11²)
  ≈ ~11px, detector-limited — one shot, no iteration, still far better than Phase
  0 (median 19/p90 71). Determinism std 0.0 is very clean; re-check cross-session.
  **PHASE 4 PLAN (revised):** (a) characterize per-axis/direction curves (+X,-X,
  +Y,-Y) and confirm a diagonal 2D target lands ~one-shot; (b) build a calibration
  routine that learns the curve (one-time, or cached in ballistics.json); (c)
  rework production moveToPixel to: detect current pos → ONE open-loop
  curve-based shot to target → at most ONE detector-fed correction. Faster than
  the 4–5-pass micro-step loop AND more accurate. Validate LIVE at N≥80 paired vs
  Phase 0 baseline; success = p90 tail collapses and median ≈ detector floor.

- **2026-07-20 (Phase 4a — transfer function is ISOTROPIC + direction-symmetric,
  per-axis-probe.ts):** single-report displacement per direction (px, std 0.0):
  +X and -X are IDENTICAL (15,49,89,120,136,157 for M=20..127); +Y is a constant
  0.965× of X (14,47,86,115,131,152) — which is EXACTLY the HDMI mapping ratio
  (Y 0.800 px/logical vs X 0.829; 0.800/0.829=0.965). So in the iPad's LOGICAL
  space the accel curve is identical on both axes and both directions — ONE curve
  covers everything. (-Y had 2 bad getCursor reads — 943px/`?`, impossible in a
  944px region — but its clean points M80/100/127 = 115/130/151 match +Y, so no
  real asymmetry.) Implication: a 2D one-shot is per-axis bursts from one curve.
  Running one-shot-2d.ts to validate one-shot to real 2D target pixels next.

- **2026-07-20 (Phase 4b — 2D ONE-SHOT lands on target, one-shot-2d.ts):** from a
  reset start, read P0 (getCursor), plan per-axis bursts to the target pixel,
  emit X-burst then Y-burst, measure |landing-target| vs getCursor. N=5 each:
  Files 0.5px, AppStore 1.3px, Settings 2.6px, Books 5.2px. AGGREGATE N=20:
  median **1.7px**, p90 **5.3px**, max 5.7px, 100% within 10px. The emit model is
  comprehensively SOLVED: deterministic, isotropic, invertible curve; one shot
  hits a 2D pixel to ~5px, no iteration. (Books worst ~5px — farthest/lowest;
  sequential X-then-Y burst accumulates slightly. Still <6px.)
  UNCHANGED CAVEAT: getCursor start = perfect; production reads start from the
  detector (~11px), so a production one-shot floors ~11px, NOT 1.7px. That
  detector-start step is the ONLY remaining production error source and MUST be
  tested before any live-win claim (this is exactly where past "offline gains"
  failed to translate).
  **PHASE 5 PLAN (next — the real translation test):** (a) add a
  `strategy:'curve-one-shot'` path to moveToPixel: detect current pos → ONE
  curve-based open-loop shot → at most ONE detector-fed correction (curve
  hardcoded from this session for the first A/B; tight region is stable). (b)
  A/B it vs the current default via bench-4.3, scored on getCursor, N≥80 paired.
  Success = median ≤ ~12px AND p90 tail collapses (71→<25) beyond the noise floor.
  (c) ONLY if it wins live: build a calibration routine to learn the curve
  (cache in ballistics.json) for cross-session/resolution robustness. Do NOT
  ship on the emit-only numbers — the detector-start test is the gate.
