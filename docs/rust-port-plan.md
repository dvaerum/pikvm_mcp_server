# Node.js → Rust port: honest scope, effort, and expected performance impact

Status: PLANNING ONLY (task_721cb397235a). No porting work has started or is
recommended to start from this doc alone.

## TL;DR recommendation

**Do not pursue a full port.** The measured bottleneck (task_78184455df4e:
inference via onnxruntime-node is 95-97% of request time, JS overhead ~3%) is
already native code regardless of host language — a Rust rewrite of the
orchestration layer cannot make onnxruntime's own C++ kernels run faster. Best
case, eliminating ALL JS overhead entirely (impossible in practice) buys
~3% off the dominant hot paths. Against that: 19,083 non-test LOC, 1240 tests,
and months of hard-won mover/HID-safety bugs (several caught by real hardware
gates *this session alone* — see below) that a rewrite risks silently
reintroducing. That is a bad trade. **This is not an argument against ever
touching a hot spot** — see §4's explicit escape hatch: if a real, narrow,
non-native cost is ever found, the answer is a scoped native addon for that
one spot, not a language migration.

*(v2 — revised after nixos-dev's round-1 critical review. Changes: §1's
95-97%/3% citation now explicitly scoped as a pre-PR93 measurement with the
re-derivation argument spelled out rather than silently carried forward; §2's
startup-cost claim split by deployment mode (daemon vs. interactive stdio);
§2's RSS number flagged as an unverified Mac-not-Pi4 assumption with the
zero-swap OOM-kill risk named explicitly; §3 now cites concrete magic-number
constants as evidence; §4 sharpened into an explicit scoped-native-addon
escape hatch; added the XNNPACK corroboration nixos-dev found independently.
Nothing in the underlying recommendation changed — the review strengthened
the evidence, it didn't overturn the conclusion.)*

## 1. Scope: JS-only logic vs. already-native-delegated

Real measurement, not estimate:

- **19,083 non-test LOC** across 48 files (`find src -name '*.ts' | grep -v
  __tests__ | xargs wc -l`).
- **11 files** import `onnxruntime-node` or `sharp` directly: `client.ts`,
  `cursor-ml-detect.ts`, `cursor-detect.ts`, `curve-mover.ts`, `snapshot.ts`,
  `brightness.ts`, `template-set.ts`, `hid-diagnosis.ts`, `health-check.ts`,
  `pointer-accel.ts`, `ipad-region-detect.ts`.
- The two largest files by LOC — `move-to.ts` (2747) and `index.ts` (2513) —
  are **orchestration**, not compute: correction-loop control flow, MCP tool
  schema/dispatch, HTTP client calls to kvmd. Per the task's own cited
  profiling, this class of code is exactly the ~3% that's already cheap.
- The genuinely CPU-bound work — cascade grid search, ONNX tensor
  construction/inference, JPEG decode/encode — already runs through
  `onnxruntime-node`/`sharp`'s native bindings from ALL 11 of those files. A
  Rust port would call the *same* onnxruntime C++ library through a different
  FFI boundary; the kernels themselves don't get faster.
- I did not find a hot path that profiling missed. The other 37 files are
  protocol/business logic (MCP tool definitions, HID recovery state machines,
  calibration bookkeeping, prompt text) — I/O- or control-flow-bound, not
  CPU-bound, so language choice doesn't move their wall-clock meaningfully.

**Conclusion**: there is no large hidden JS-only compute cost to "unlock" by
porting. The 95-97/3% split already accounts for essentially the whole
codebase's shape.

**Caveat, flagged by review rather than glossed over**: the 95-97%/3% figure
is task_78184455df4e's PRE-PR93 measurement, taken when the cascade scanned
N=352 crops. Post-PR93 the hint-narrowed hot path scans ~49-64 crops — I did
not re-run that profiling methodology to confirm the percentage split still
holds at the new N. My reasoning for why it likely still does: both the
numerator (inference time, which scales with crop count) and the denominator
(total request time, dominated by that same inference) shrink together when N
drops, so the *ratio* should be roughly stable even though the *absolute*
numbers are both smaller — this is a proportional-scaling argument, not a
re-measurement. Independent supporting evidence from my own PR93 gate work:
the real on-box `move_to` still measured a 13.8s median post-fix
(task_93118fdf3c5b / PR93 gate) — nowhere near fast enough for JS-side
overhead (single-digit-to-low-double-digit ms, per this doc's own
startup/isolated-call measurements) to be a meaningful share of that number. So while the *exact*
percentage is unconfirmed post-fix, the *qualitative* conclusion (inference
dominates, JS is not the hidden cost) is corroborated by a different, more
recent, real measurement — not merely carried forward unchecked.

## 2. Where a port could realistically help (if anywhere) — real measurements

Tested the three non-inference angles the task asked me to check, on this
exact machine, rather than asserting from priors:

- **Process startup**: `time node dist/index.js --target ipad` to the
  `"PiKVM MCP Server running (stdio)"` marker measured **172-259ms** across 2
  cold runs. **Which deployment mode this covers, precisely** (flagged by
  review — my first draft over-generalized this): the appliance daemon
  (`pikvm-mcp.service`, systemd-managed, genuinely long-lived) pays this cost
  once per deploy/reboot — negligible. The interactive path
  (`scripts/pikvm-mcp-stdio.sh`, stdio transport) is typically spawned fresh
  **per client session**, plausibly dozens of times a day under active
  interactive use — not "once ever," closer to "once per session-start." Even
  at that cadence, 172-259ms per session-start is still dwarfed by a single
  13-27s `move_to` on Pi4 hardware (post-PR93) — one slow move costs more than
  50+ session-starts combined — so the conclusion (not where the user-felt
  latency lives) holds for both modes, but "one-time" was doing more work than
  the actual restart cadence supports for the interactive path specifically.
- **Memory footprint**: `/usr/bin/time -l` on a running server (3s after
  spawn, before any request) measured **~108MB max RSS** on this Mac
  (113,459,200 bytes) — not the Pi4 target, flagged in earlier drafts as an
  unverified assumption rather than a checked fact given the Pi4's 3.6GB RAM
  with **zero swap** (which doesn't degrade gracefully, it OOM-kills) shared
  with kvmd/ustreamer/hid-latch-monitor. **Now checked**: pikvm-nixos@it-03400
  pulled real numbers off a live Pi4 running the identical service (§5.5) —
  VmRSS 127.2MB idle, VmHWM 153.7MB peak. Close to the Mac estimate, not
  wildly different, and comfortable against 3.6GB with zero swap — "not
  currently a problem" is now a checked fact, not an assertion. Some of this
  is V8/Node's own baseline (a Rust binary would trim this part meaningfully);
  a large and *language-independent* share is onnxruntime's own native
  runtime + loaded model weights, which a Rust build would load via the
  identical C++ library and pay the same cost for either way.
- **GC-pause elimination for latency-SENSITIVE (not latency-DOMINANT) paths**:
  this is the one place a genuine, narrow case could exist — e.g. if HID
  emit timing has a tight tolerance where a GC pause mid-sequence could
  matter. I did not find evidence of this in the codebase or this session's
  incident history (the mover bugs found and fixed this session — N1's
  correction-loop dead-exit, the cornerTargetFromBounds P0, the streamer
  idle-stop race — were all algorithmic/logic bugs, not timing-jitter bugs).
  If this angle is worth pursuing, it should be its own targeted
  investigation (profile for GC pauses coinciding with HID emit windows) —
  not assumed and not bundled into a full-system port.
- **Maintenance/reliability, distinct from speed**: Rust's type system would
  catch a class of bugs TypeScript's structural typing doesn't (e.g., some of
  this session's null/undefined-handling edge cases). But this project
  already leans hard on runtime verification (1240 tests, live hardware gates
  every PR) specifically *because* the risk surface is physical/behavioral
  (HID/mover correctness), not type-safety gaps — the bugs this session
  actually found (N1, cornerTargetFromBounds, the streamer race) were logic
  bugs a stricter type system wouldn't have caught either. I don't see a
  strong maintenance case specific to this codebase's actual failure history.

## 3. Realistic effort estimate

- **1240 tests / 123 test files**, several ADRs, and (from this session's own
  gate history alone) at least 5 distinct hard-won hardware bugs caught only
  via live iPad-rig verification, not by offline tests: the N1 mover
  correction-loop dead-exit, the cornerTargetFromBounds P0 (a deterministic
  ~619px miss that offline tests didn't catch), the streamer idle-stop
  proxy gap, the iPad re-locking pattern, and the cascade full-region-scan
  cost itself. A rewrite in a new language, by a team not already carrying
  all of this hard-won context in their heads, has real, demonstrated risk of
  silently reintroducing some subset of these — this project's own recent
  history is the evidence, not a hypothetical.
- **Concrete, not abstract, per review**: the "tests encode intent, not just
  assertions" claim above is easy to wave away in the abstract, so here are
  actual magic-number constants a port would have to reproduce correctly,
  each backed by a paragraph of empirical justification a rewrite would need
  to either preserve verbatim or re-derive from scratch:
  - `TAUTOLOGY_PROX_THRESHOLD = 30` (`move-to.ts:692`) — the proximity
    threshold below which an ML detection is suspect for the Phase 310
    tautology failure mode (an icon-feature false-positive reported as the
    cursor). Get this constant wrong and detections silently skip a needed
    wiggle-verify, reproducing a class of bug this codebase already lived
    through once.
  - `HEATMAP_FLOOR = 0.2` (`cursor-ml-detect.ts:752`, re-verified against
    current origin/main after re-fetching — PR93 shifted this file's line
    numbers ~86 lines since I first cited it) — set just above the
    empirically-observed 0.12-0.14 confidence band that a real degenerate
    corner-prediction failure mode (documented against a specific captured
    trace, "PA19-c Books") scored at. Too low and degenerate predictions pass
    through again; too high and valid detections get rejected.
  - `HINT_WINDOW_RADIUS_PX = 150` (PR93/task_484bed055820, this session) —
    justified against curve-mover's own documented finding that a landing
    >80px from a deterministic emit's target can ONLY be a detector false
    positive, never a real detection. Nixos-dev, who added this constant,
    specifically flagged it as the kind of value a port "getting even one of
    these subtly wrong" risks reproducing exactly the class of confident-
    wrong-false-positive incident this codebase already lived through once
    (the 2026-05-28 hint-crop-fallback regression found while designing
    PR93) — a port project inheriting the number without the incident
    history behind it is exactly the risk this bullet is about.
- Porting scope, if pursued despite the recommendation above, would need to
  cover: MCP protocol handling (stdio + Streamable HTTP transports), HID/
  streamer HTTP client (`client.ts`, 897 LOC), the full mover/detection
  orchestration (`move-to.ts` 2747 + `cursor-detect.ts` 1259 +
  `cursor-ml-detect.ts` 755 + `curve-mover.ts` 450 + supporting modules),
  calibration/ballistics (699 LOC), and re-porting or re-deriving all 1240
  tests' intent (not just their assertions — many encode hard-won behavioral
  contracts, not just current-output snapshots).
- A **full** port is a multi-month effort for a team with zero domain
  familiarity advantage over the current maintainers, given the actual
  complexity lives in domain logic (mover physics, detection cascades, HID
  timing quirks) that doesn't get simpler by changing language.
- A **partial** port (e.g., just the onnxruntime/sharp-touching modules) saves
  little given §1's finding — those modules are already thin wrappers around
  native code; porting the wrapper doesn't touch the actual cost.

## 4. Honest recommendation

**No.** The dominant, measured bottleneck is already native and
language-independent; a rewrite cannot improve it further. The startup/memory
angles are real but small, one-time, and not currently the source of any
reported pain (the pain — 13-27s/move on Pi4 — is inference-cascade cost,
already addressed separately and successfully via PR93/task_484bed055820's
hint-narrowing fix, which measured a real 1.6-1.8x on-box improvement without
touching the host language at all). The maintenance/type-safety case doesn't
match this project's actual failure history (logic bugs caught by live
hardware gates, not type errors). Against a multi-month rewrite carrying
concrete risk of reintroducing several already-fixed, hard-won bugs, this is
a large investment for a small and mostly-already-realized return.

**Explicit escape hatch (sharpened per review — this was only implicit in
v1)**: this doc rejects a full port; it does NOT reject ever touching a hot
spot. task_78184455df4e — the task that started this whole investigation
arc — already said it plainly: *"If real non-native overhead turns up,
that's a MUCH smaller, targeted fix (e.g. a scoped native module for just
the hot spot) than a full Rust rewrite."* That's the operative rule going
forward. If either of the two open threads below pans out into a real,
localized cost, the answer is a **scoped native addon** (`napi-rs` or
`neon`, called from the existing TypeScript orchestration layer) for that
ONE hot spot — not a language migration of the other 19,000+ lines that
aren't the problem:

1. **GC-pause-vs-HID-timing coincidence** — thin evidence today (§2), not
   this task's job to prove or disprove, but explicitly scoped as a future
   candidate for the native-addon treatment if a targeted profiling pass
   ever confirms it's real.
2. **The on-box-vs-isolated speedup gap** — PR93's isolated detection-call
   test measured a 5-6x speedup from hint-narrowing; the real on-box
   `move_to`/`click_at` only realized 1.6-1.8x. That gap (not the host
   language) is where remaining real latency is most likely still hiding —
   worth investigating directly (further tuning `HINT_WINDOW_RADIUS_PX`, or
   profiling what else consumes the other ~10+ seconds of a Pi4 move) before
   assuming a rewrite of anything is the answer.

**Corroboration found by nixos-dev while investigating an unrelated XNNPACK
acceleration spike, CORRECTED in v4 (see §5 below)**: XNNPACK is a dead end
for `onnxruntime-node` *specifically* — Microsoft's own binding source
(`session_options_helper.cc`) has no provider-dispatch code path to request
it, confirmed on both the pinned and current upstream versions. My v1-v3
read of this as evidence that a Rust port would hit "the identical XNNPACK
gap" was **wrong** — georg caught the actual distinction: the gap is in
onnxruntime-node's own incomplete JS↔C++ binding layer, not in the
underlying onnxruntime C++ library itself, which has confirmed-working
XNNPACK support (the Python wheel built during the spike loaded and ran it
successfully) — and Rust's `ort` crate binds directly against the C API with
a real, working `xnnpack` feature flag (verified: crates.io lists it; XNNPACK
itself supports Linux/aarch64, the Pi4's exact architecture, via ONNX
Runtime's own `--use_xnnpack` build option). So this data point actually cuts
the OTHER way from what I originally wrote: it's the one place a *narrow*,
*scoped* native-addon rewrite (not a full port) could plausibly unlock
something a pure Node.js path structurally cannot reach. See the new §5
below for the concrete sub-plan.

## 5. Sub-plan: scoped Rust-native-addon for XNNPACK inference (task_1f094d75e393)

This is the escape hatch from §4 made concrete for one specific candidate —
NOT a reopening of the full-port question. Everything in §§1-4 stands: this
is a single, narrow component, called from the otherwise-unchanged existing
JS server exactly where inference happens today.

### 5.1 Feasibility — checked, not assumed

- **`ort` crate genuinely supports XNNPACK**: confirmed via its published
  docs/crates.io listing — execution providers are opt-in Cargo feature
  flags, and `xnnpack` is one of them, with automatic fallback to plain CPU
  execution if registration ever fails (a safe, non-silent-corruption
  failure mode — worth confirming that fallback doesn't silently mask a
  broken XNNPACK path in practice, but the *design* is fail-safe).
- **XNNPACK supports the Pi4's actual architecture**: ONNX Runtime's own docs
  confirm XNNPACK builds for Linux/ARM including aarch64 via the
  `--use_xnnpack` build flag — this is not an Android/WebAssembly-only
  feature as an early, incomplete read of the search results suggested; a
  closer read of ONNX Runtime's own platform-support docs confirms aarch64
  Linux is supported.
- **napi-rs is a real, maintained bridge**: builds precompiled Node.js
  addons in Rust via Node-API, generates TypeScript defs, no `node-gyp`
  required. Its own documentation is explicit that native addons are "the
  last 10x move, not the first" and are only worth it once profiling
  confirms a real hot spot — exactly the discipline this whole doc has tried
  to apply throughout, and exactly why this is being proposed as a
  **feasibility spike**, not a committed rewrite (§5.3).
- **What I have NOT verified**: that this specific ONNX model (the dual-head
  crop-cascade detector) actually gets faster under XNNPACK on THIS specific
  hardware. Nobody has — the binding gap was found before any such test
  could run. This is the open empirical question §5.3 is for.

### 5.2 Scope — kept as narrow as the escape-hatch principle demands

- Replaces exactly one thing: the ONNX inference call currently made via
  `onnxruntime-node`'s `session.run()` in `cursor-ml-detect.ts`'s
  `runCascadeInference` — the batched tensor-in/heatmap-out call, nothing
  else in that file or elsewhere.
- Model I/O contract is unchanged: same tensor shapes, same preprocessing
  (mean/std normalization, crop batching), same postprocessing (presence
  threshold, heatmap soft-argmax) — all of that stays exactly where it is in
  TypeScript. Only the inference call itself crosses into the native addon
  and back.
- Everything else in the codebase — HID, streamer, MCP protocol, mover
  orchestration, the other 47 files from §1 — is completely untouched. This
  is the opposite of a rewrite: one function call gets a new implementation
  behind the same call site.

### 5.3 The open empirical question — propose a minimal spike, not a commitment

Never benchmarked, because the binding gap was found before any test could
run. Proposed first step: build a minimal `napi-rs` addon wrapping `ort`
with the `xnnpack` feature enabled, load the actual production cascade
model, and run a real fp32-CPU-vs-XNNPACK comparison **on the actual Pi4**
(not this Mac) — same "prove it before committing further" discipline as
GPU and INT8, both of which looked promising on paper and lost to real
measured overhead this session. XNNPACK's mechanism (a hand-optimized
NEON/SIMD kernel library, not a coprocessor round-trip or a quantization
accuracy tradeoff) is genuinely different from either of those, so it isn't
assumed to repeat that failure pattern — but it isn't assumed to avoid it
either. Spike deliverable: one number — real crop-batch inference latency,
XNNPACK vs. current CPU provider, on the Pi4, holding everything else fixed.

### 5.4 Effort/risk vs. the full-port numbers (§3), apples-to-apples

- **Full port** (§3): 19,083 LOC, 1240 tests, multi-month effort, touches
  every subsystem, concrete demonstrated risk of reintroducing hard-won bugs
  (the magic-number examples in §3).
- **This spike**: one new small Rust crate + one napi-rs binding, one
  call-site swap in one function in one file, zero changes to HID/mover/
  protocol logic, zero changes to the 1240 tests' intent (the model contract
  and postprocessing thresholds — `HEATMAP_FLOOR`, `TAUTOLOGY_PROX_THRESHOLD`
  — are untouched; they gate the *output* of inference, not how inference
  itself is computed). A rough order of magnitude smaller and safer than the
  full port, and the spike itself (before committing to shipping it) is
  smaller still — a standalone benchmark harness, not even wired into the
  production call path yet.

### 5.5 Recommendation

**Worth attempting the spike.** Unlike the full port (§4: clear no), this is
cheap to test and the potential payoff is real: if XNNPACK gives a genuine
2x+ speedup on this model on this hardware, it stacks with PR93's own
1.6-1.8x on-box win (§4, point 2) rather than competing with it — the two
are orthogonal (fewer crops scanned × faster-per-crop). If the spike shows
XNNPACK doesn't meaningfully help this specific model/hardware combination
(plausible — small models with irregular crop-batch shapes don't always
benefit from SIMD-heavy kernels the way larger, regular-shaped models do),
the cost is one afternoon's throwaway benchmark code, not a wrong multi-month
bet. This is exactly the shape §4's escape hatch describes: small, scoped,
falsifiable before any commitment to ship it.

**Real Pi4 RSS data, obtained per nixos-dev's round-2 ask** (pikvm-nixos@
it-03400, live `pikvm-mcp.service`, PID 736202, ~3.2h uptime post-PR93
deploy): VmRSS (idle, settled) **127.2 MB**, VmHWM (peak since start)
**153.7 MB** — not a pristine pre-first-request reading (a couple of
read-only health-check probes happened ~3h before the read), but real,
on-target, and close to this doc's Mac-measured ~108MB estimate (§2) rather
than wildly different — the earlier "unverified assumption" caveat is now a
checked fact, and it doesn't change §2's or §4's conclusions: 127-154MB
against 3.6GB with zero swap is comfortable headroom, not a Rust-for-memory
argument on its own.
