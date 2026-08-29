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

---

# Part II — full-port technical plan (ADR-0002, task_63dd02e1bd7e)

Georg has decided to proceed with a full Rust port anyway, on **preference/
maintainability grounds, explicitly not performance** — see
`docs/adr/0002-rust-port-full-bigbang.md` for the decision record. Parts
I (§§1-5) above are NOT retracted: they correctly answer "would this help
speed" (no) and remain the reference for why this isn't a performance
project. Part II answers a different question — given the decision is made,
how should it actually be done.

## 6. Library-first ground rules

Standing rule for whoever implements: **use a mature, established crate
instead of hand-rolling infrastructure, wherever one genuinely exists and
fits.** Any case where hand-rolling is chosen over an available crate needs
explicit justification recorded in that module's own task, not a silent
default. Concrete evaluation, not a generic "use good libraries" gesture:

- **MCP protocol — `rmcp`** (`modelcontextprotocol/rust-sdk`, the OFFICIAL
  Rust SDK — corrected per review: the repo's own README references
  migrating to a 3.x line, not v0.16.x as I first cited; a documented
  cross-major-version migration guide indicates a MORE established project
  than a pre-1.0 number would suggest, strengthening rather than weakening
  this recommendation). Confirmed (nixos-dev, independently) supports both
  stdio AND Streamable HTTP transports — matching this codebase's actual
  need (`scripts/pikvm-mcp-stdio.sh`'s interactive path AND the on-box
  `pikvm-mcp.service`'s HTTP path, task_93118fdf3c5b) — plus both server
  and client roles. This directly answers the task's "check whether an
  official Rust MCP SDK exists before hand-implementing the wire protocol"
  — **yes, it exists, use it.** Hand-rolling the MCP wire protocol (JSON-RPC
  framing, session handling, Streamable HTTP transport) would be pure
  duplicated effort against a maintained official implementation.
- **ONNX inference — `ort`**. Already evaluated in §5: binds directly
  against the onnxruntime C API, has a real, working `xnnpack` feature flag
  confirmed for Linux/aarch64 (the Pi4's architecture) — something
  `onnxruntime-node` structurally cannot offer (§4's corrected XNNPACK
  finding). This is the one place the port can plausibly do *better* than
  the current implementation, not just port it — pending §5.3's spike to
  confirm XNNPACK actually helps this specific model.
- **HTTP framework — `axum`**, over `actix-web`. Actix-web has a raw-
  throughput edge (10-15% under heavy load per current comparisons), but
  this project is not throughput-bound (§§1-5's whole point) and axum is
  built by the Tokio team specifically for type-safe ergonomic composition
  with `tower-http`/`tracing` — a better fit for a maintainability-driven
  port than a framework chosen for a performance property this project
  doesn't need.
- **WebSocket (streamer keepalive, iPadCollector ground-truth link) —
  `tokio-tungstenite`**. Does not have built-in HTTP/HTTPS proxy support
  (relevant: georgs-mac-mini's node requires a loopback CONNECT-tunnel proxy
  for all traffic, per `PiKVMConfig.proxyUrl`) — but the fix is already
  known and already validated in the current codebase:
  `streamer-keepalive.ts`'s `ConnectTunnelAgent` (PR91,
  task_484bed055820-adjacent) is exactly "establish a CONNECT-tunneled TCP
  stream by hand, then hand it to the WS layer" — tokio-tungstenite accepts
  a pre-established stream the same way. Port the *pattern*, not a novel
  design.
- **Serialization — `serde`/`serde_json`**. No real alternative worth
  evaluating; this is the ecosystem default for a reason.
- **Image decode/resize/crop (replacing `sharp`)** — the `image` crate for
  general handling, with `libjpeg-turbo-rs` (or `turbojpeg` bindings) for
  the JPEG-heavy hot path specifically (screenshot decode is JPEG
  throughout this codebase). `fast_image_resize` (SIMD-accelerated, crop
  support) if resize/crop ends up being a measurable cost independent of
  decode — check before adding, don't assume.
- **Not evaluated in depth here, flag for the implementing module's own
  task**: an ARM SBC HID/USB-gadget interaction layer (currently plain HTTP
  calls to kvmd — likely stays HTTP client code via `reqwest` or axum's own
  client, no exotic dependency needed) and the SSH-based HID-latch source
  (`hid-latch-ssh-source.ts`) — check for a maintained Rust SSH client crate
  (e.g. `russh`) rather than shelling out, when that module's task comes up.

## 7. Module-by-module technical plan

Broken into logical build units below, filed as real agent-mcp subtasks
under task_63dd02e1bd7e (not just prose) per the task's explicit ask:
task_39b946273448 (module 1), task_dbf947d5d878 (module 2),
task_72403c2d858c (module 3), task_9bb80e84c948 (module 4),
task_4719c8794fbd (module 5), task_ead854232bc8 (module 6) — see the task
tracker for each one's full scope/dependency/validation detail. Summary of
the grouping and proposed build sequence (each layer depends only on layers
before it):

1. **Foundation** (~530 LOC: `config.ts`, `settings.ts`, `auth.ts`,
   `session-auth.ts`, `kvmd-auth.ts`, `lock.ts`, `util.ts`, `version.ts`) —
   no PiKVM domain logic, pure infrastructure. Build first; everything
   else depends on it.
2. **kvmd transport client** (~1,280 LOC: `client.ts`, `streamer-keepalive.ts`,
   `operator-hints.ts`) — REST + WS to the PiKVM appliance. The `ort`/`axum`/
   `tokio-tungstenite` choices from §6 land here first, and this is the
   layer every other layer calls through.

   **Real cross-layer coupling point, found by nixos-dev tracing the actual
   import graph rather than trusting the LOC grouping** — flagged here
   explicitly because the strict "depends only on layers before it" framing
   understates it: `CursorBelief`'s state storage lives on `PiKVMClient`
   (`client.belief`, this layer), but it's actively read AND WRITTEN by
   layer 4's movers (`move-to.ts`/`curve-mover.ts` read `client.belief`
   before planning a move, then feed observations back via the locator's
   `observe()`). That's not a clean one-directional "layer 4 calls into
   layer 2's finished API" relationship — it's a shared-mutable-state
   handoff spanning layers 2 (storage), 3 (`cursor-belief.ts`'s own
   transition logic, layer 3 below), and 4 (the actual read/write call
   sites). **Design `CursorBelief`'s Rust interface with layer 4's real
   read/write pattern already in mind when this module is built** — don't
   treat this module as "done" and discover the real requirements once
   layer 4 is underway; that would mean reworking an API already marked
   complete.

   **Resolved (2026-08-28), and it turned out to need action before
   client.rs could even compile, not just before layer 4 lands:**
   `PiKVMClient` needs the `CursorBelief` TYPE itself as a struct field
   (`belief: CursorBelief`), but `cursor-belief.ts` is nominally layer 3's
   file — a strict top-down build order would block module 2 on module 3.
   Checked the file itself before deciding: zero imports, "pure /
   deterministic / no I/O" per its own header — the ideal shape for a
   dependency-free shared crate. Given its own crate,
   **`pikvm-mcp-cursor-belief`** (`rust/cursor-belief`, depends on nothing),
   which both module 2 (`kvmd-client`, this layer) and module 3 depend on
   directly instead of one blocking the other. Same class of finding, same
   resolution shape, as the `pikvm-mcp-ipad-primitives` extraction under
   module 5 below. 48
   tests ported faithfully from both `cursor-belief.test.ts` and
   `cursor-belief-integration.test.ts` (including a bit-for-bit port of the
   TS test's deterministic LCG noise generator), all passing first run.
3. **Detection/vision** (~4,900 LOC: `cursor-detect.ts`, `cursor-ml-detect.ts`,
   `cursor-shape-detect.ts`, `cursor-belief.ts`, `cursor-locator.ts`,
   `orientation.ts`, `ipad-region-detect.ts`,
   `template-set.ts`, `seed-template.ts`, `brightness.ts`, `capture.ts`) —
   the ONNX/image-crate-heavy layer; the model contract and thresholds from
   §3's magic-number examples live here and must port byte-for-byte, not
   be "improved" along the way.

   **Fourth crate-boundary finding (2026-08-28, nixos-dev), same shape as
   the three above**: `seed-template.ts` (this layer) needs
   `looksLikeCursor` — but that function is defined in `move-to.ts`
   (layer 4, not yet started). Checked the actual TS source first: it's
   pure (operates only on `CursorTemplate`, zero `PiKVMClient`/mover
   dependency). Unlike the CursorBelief/ipad-primitives/cursor-belief-
   crate cases, this one is NOT a new dependency edge — layer 4 already
   depends on layer 3 per this section's own build order (foundation →
   kvmd-client → detection/vision → mover), so pulling a pure function
   forward into layer 3 as `looks_like_cursor.rs` (+ its
   `cohesiveBlobInMask` helper) just moves it to where it's first
   needed, nothing more. When module 4's `move-to.ts` is ported, it
   imports `looks_like_cursor` from `pikvm-mcp-detection-vision` rather
   than re-porting it.

   **Fifth crate-boundary finding (2026-08-28, nixos-dev), opposite
   direction from the fourth**: the task list originally filed
   `cursor-anchor.ts` under this layer, but the actual TS source imports
   `slam.ts` directly — and `slam.ts` is layer 4 (mover), not layer 3.
   Per this section's own dependency ordering (mover depends on
   detection/vision, never the reverse), `cursor-anchor.ts` cannot live in
   `pikvm-mcp-detection-vision` without inverting that edge. Confirmed
   against the real import graph, then against georgs-mac-mini (slam.rs's
   owner) before moving it: **`cursor_anchor.rs` lands in `rust/mover/`**,
   alongside `slam.rs`, not in detection-vision. One follow-on extraction
   fell out of this: `slam.rs` carried a private
   `detect_bounds_or_null`/`detect_ipad_bounds` pair (client-taking
   wrapper around orientation.rs's buffer-based detector) with its own
   comment flagging it as "move into detection-vision once a second
   caller needs it (cursor-anchor.rs will)" — cursor-anchor.rs is exactly
   that second caller, so the pair was promoted to a shared, public home
   in `orientation.rs` and slam.rs's private copy deleted (slam.rs's 20
   tests re-verified unchanged against the shared function before
   pushing).
4. **Mover/HID orchestration** (~5,300 LOC: `move-to.ts`, `curve-mover.ts`,
   `move-to-probe-driven.ts`, `click-at.ts`, `click-verify.ts`,
   `click-verify-archive.ts`, `ballistics.ts`, `auto-calibrate.ts`,
   `scale-learner.ts`, `scale-persist.ts`, `pointer-accel.ts`,
   `open-loop-planner.ts`, `cursor-keepalive.ts`, `slam.ts`,
   `cursor-anchor.ts`, `gesture.ts`, `ipad-unlock.ts`) —
   the largest, highest-risk layer: this is where N1's correction-loop bug,
   the cornerTargetFromBounds P0, and PR93's cascade-hint logic all live.
   `move-to.ts` alone (2,711 LOC) is the single largest file in the
   codebase — plan for it as its own dedicated sub-effort, not folded into
   a generic "mover" task.
5. **iPad-specific / HID recovery** (~3,300 LOC: `ipad-app-ws.ts`,
   `ipad-keys.ts`, `hid-recovery.ts`, `hid-mode.ts`,
   `hid-diagnosis.ts`, `hid-latch-monitor.ts` + `-runner`/`-ssh-source`/
   `-local-source`/`-monitor-main`, `health-check.ts`,
   `desktop-e2e-metrics.ts`) — the #51 stale-settle-latch incident's home;
   largely independent of layer 4, can build in parallel with it.

   **Second real cross-layer coupling point, found by nixos-dev surveying
   module 5's FULL import surface (all 13 files) before writing code** —
   this "largely independent of layer 4" framing is also an
   understatement: `ipad-unlock.ts` imports `takeRawScreenshot` from
   `ballistics.ts` and `emitChunked` from `gesture.ts`; `hid-mode.ts`
   imports `defaultChunkPaceMsFor`/`defaultMaxResidualPxFor` from
   `click-verify.ts` — all layer 4 files. Checked against the actual TS
   source (2026-08-28) rather than taken on trust: `emitChunked(client:
   PiKVMClient, ...)` calls `client.mouseMoveRelative(...)` and
   `takeRawScreenshot(client: PiKVMClient)` calls `client.screenshot()` —
   both take the concrete layer-2 client directly, not an injected
   closure. `defaultChunkPaceMsFor`/`defaultMaxResidualPxFor` are pure
   (`bool -> Option<number>`, no client dependency at all).

   **Resolution — do NOT fold into module 1 (foundation).** Foundation
   has zero PiKVM/HID domain knowledge by design (§7.1: "no PiKVM domain
   logic, pure infrastructure") and nothing else in the dependency graph
   runs foundation → kvmd-client; putting a function that calls
   `client.mouseMoveRelative`/`client.screenshot` there would force
   foundation to depend on module 2, inverting the one dependency edge
   the whole workspace structure is built on. Instead: a new crate,
   **`pikvm-mcp-ipad-primitives`** (`rust/ipad-primitives`), depending on
   `pikvm-mcp-kvmd-client` (module 2), holding `emit_chunked` (gesture.rs),
   `take_raw_screenshot`, and the two `click-verify` default-lookup
   functions. Modules 4 and 5 both depend on `ipad-primitives` instead of
   on each other — this is the same "extracted because two consumers need
   the same mechanism without an import cycle" pattern the codebase
   already used once for `ipad-keys.ts` (F7, Round 2 Phase 4), just given
   its own crate boundary instead of a same-crate file. Module 5 is no
   longer blocked on module 4 landing first; only on this small crate,
   which module 2's owner (or whoever gets there first) should build
   before either of modules 4/5 needs it in earnest — it's ~50 LOC of
   faithful port, not a design risk.

   **Correction (2026-08-28, nixos-dev) — `emit_chunked` did NOT end up
   in `pikvm-mcp-ipad-primitives`.** The premise above was that
   `ipad-unlock.ts` (module 5) was one of its two real callers, alongside
   `move-to.ts` (module 4) — hence the shared crate. The seventh finding
   below found `ipad-unlock.ts` itself actually belongs in `rust/mover`
   (module 4), not module 5. With that corrected, `emit_chunked`'s two
   real callers (`move-to.ts`, `ipad-unlock.ts`) are BOTH `rust/mover`
   files — nothing outside mover needs it, so it lives there directly as
   `mover::gesture`, not through `ipad-primitives`. `take_raw_screenshot`
   and the two `click-verify` default-lookup functions are unaffected —
   `ipad-primitives` still exists for those (module 5's `hid-mode.ts`
   genuinely does need the `click-verify` pair, and `take_raw_screenshot`
   awaits `ballistics.ts`).

   **Sixth crate-boundary finding (2026-08-28, nixos-dev), a direct
   consequence of the fifth (cursor-anchor.ts, §7.4 above)**: `ipad-keys.ts`
   itself was ported into this crate first (its TS source sits alongside
   this module's other `ipad-*.ts` files), landing as
   `ipad_hid::ipad_keys`. But its own header comment already named BOTH
   real callers — `ipad-unlock.ts` (this module) AND `cursor-anchor.ts`'s
   `key-sequence-retry`/`defensive-keys` recovery kinds — and
   cursor-anchor.ts turned out to belong in `rust/mover` (module 4, per the
   finding just above), not module 3 as originally filed. A module-4 file
   depending on this module-5 crate would invert the module 4→5 direction
   the same way the `emit_chunked`/`take_raw_screenshot` case above did.
   Moved `ipad_keys.rs` into `pikvm-mcp-ipad-primitives` alongside
   `click_verify` — the exact "both modules 4 and 5 need this, neither
   depends on the other" crate this section already built, for the exact
   reason its own description already named `ipad-keys.ts` as precedent.
   Zero real callers existed anywhere in the Rust port yet, so this was a
   clean mechanical move (all 15 `ipad-primitives` tests pass unchanged);
   `cursor_anchor.rs` (`rust/mover`) is its first.

   Also while building `cursor_anchor.rs`'s tests: `slam.rs` and
   `cursor_keepalive.rs` (both `rust/mover`) each carried their own private
   per-file `TEST_LOCK`, meant to serialize tests that touch process-global
   state (`kvmd-client`'s `emit_clock`, `detection-vision`'s
   `LAST_GOOD_BOUNDS` cache). Adding a third, heavy consumer of the same
   globals surfaced that three separate mutex instances don't actually
   serialize against each other — `cargo test` runs a crate's tests
   concurrently by default. Replaced with one crate-wide
   `mover::test_support::GLOBAL_STATE_LOCK` all three files' tests share;
   a real, previously-latent flake, not a cursor_anchor.rs-only concern.

   **Seventh crate-boundary finding (2026-08-28, nixos-dev), same shape
   as the fifth (cursor-anchor.ts)**: the task list filed `ipad-unlock.ts`
   under this module (its TS source sits alongside this module's other
   `ipad-*.ts` files), but its real imports are `client.ts`,
   `cursor-anchor.ts`, `orientation.ts`, `gesture.ts`, `ipad-keys.ts`, and
   `util.ts` — checked against the actual source, not assumed. Nothing
   ipad-hid-exclusive (no `hid-recovery.ts`/`hid-mode.ts`/
   `hid-diagnosis.ts` reference at all). `cursor-anchor.ts` is itself a
   `rust/mover` file per the fifth finding, and `rust/ipad-hid` has no
   dependency on `rust/mover` today — filing `ipad-unlock.ts` here would
   create that edge for no reason. **`ipad_unlock.rs` lands in
   `rust/mover/`**, split into one file per exported function from the
   start (`unlock.rs`, `launch_app.rs`, `home.rs`, `app_switcher.rs`,
   `unlock_with_code.rs`) per the file-structure standing rule, rather
   than one flat ~620-line file. `gesture.ts` (`emit_chunked`) ported
   alongside it directly into `mover::gesture` — see the correction note
   above. 40 tests ported from the 5 TS test files, all passing; full
   workspace suite green. `ipad-unlock.ts`'s own real remaining gap
   (`takeRawScreenshot` from `ballistics.ts`) turned out to be a 3-line
   wrapper already functionally covered by `cursor-detect.ts`'s ported
   equivalent (`ScreenshotMode::Raw` in `slam.rs`'s own adaptation) — no
   new porting needed for it.

   **`move-to.ts`'s own submodule structure (2026-08-28, georgs-mac-mini),
   planned ahead of implementation per georg's file-structure rule (read
   the file in full first, no code written yet)**:

   The file's own first branch is the key structural fact: `moveToPixel`
   immediately delegates `strategy==='curve-one-shot'` (the iPad DEFAULT,
   validated N=80 ≈11px) to `curve-mover.ts` — already fully ported as
   `curve_mover.rs` and explicitly the SOLVED, do-not-touch path per
   CLAUDE.md. Everything else in the file (~1,200 of `moveToPixel`'s own
   1,244 lines, plus every helper above it) is the LEGACY iterative
   correction-loop path for the other three strategies
   (`detect-then-move`/`slam-then-move`/`assume-at`). This is NOT dead
   weight — `detect-then-move` is the real production DEFAULT for
   desktop/absolute-mouse targets (index.ts's own tool description:
   `"detect-then-move" (default on desktop/absolute)`) — but it is a
   materially lower hardware-gate priority than curve-one-shot: the
   iPad-critical path is already solved and gated; this path's own live
   gate belongs on a desktop/absolute target (it-03400), not the iPad rig.

   Cross-checked the full dependency graph against what's already
   ported: nearly all of it is. `cursor_locator::CursorLocator` (origin
   discovery), `cursor_anchor::anchor_cursor` (slam-then-move's guard),
   `cursor_detect` (`Cluster`/`DetectionConfig`/`diff_screenshots_decoded`
   family), `cursor_ml_detect`, `cursor_shape_detect`, `looks_like_cursor`
   (per the fourth finding above), and `template_set` (load/persist/
   migrate) all already exist in `detection-vision`. `move_to.rs` is
   almost entirely an orchestration layer over already-ported primitives,
   the same shape `cursor_anchor.rs` and `ballistics.rs` turned out to be.

   Two real gaps, not yet ported, that block starting real implementation:
   - `emit_chunked` (`gesture.ts`, ~25 LOC) — **resolved (2026-08-28,
     nixos-dev), and its home changed from what this note originally
     said**: not `pikvm-mcp-ipad-primitives` after all — see the
     correction note above the sixth finding. `ipad-unlock.ts` (this
     function's other real caller, alongside `move_to.rs`) turned out to
     belong in `rust/mover` too (seventh finding, below), so
     `emit_chunked` now lives directly in `mover::gesture`. Already built
     and tested (7 tests) — `move_to.rs` can import it from there.
   - `pointer-accel.ts` — NOT yet ported, not yet flagged anywhere in
     this doc. `learnedBallisticsPxPerMickey` (the `PIKVM_USE_LEARNED_
     BALLISTICS=1` opt-in forward-model path) depends on it entirely.
     `foundation::settings` already has the env-var plumbing
     (`use_learned_ballistics`, `pointer_accel_model`) but no actual
     `pointer_accel.rs` exists. Recommend SCOPING THIS OUT of `move_to.rs`'s
     initial port: it's opt-in, off by default, gated behind a real ONNX
     model file, and porting it means porting a whole separate file first
     for a path that isn't the iPad-critical one either. Faithful-port
     discipline still applies eventually — flagging as a deferred,
     individually-justified gap, not a silent drop.

   Also: `move-to.ts` declares its OWN third `Axis = 'x' | 'y'` type
   (line 173), structurally identical to but deliberately NOT unified
   with `slam.ts`'s (already `crate::slam::Axis` in Rust) or
   `scale-learner.ts`'s (already `crate::mover::scale_learner::Axis`) —
   `cursor-anchor.ts`'s own header comment already named this exact
   three-way split as a known, deliberately-out-of-scope TS property.
   The Rust port keeps all three independent for the same reason the
   other two already do: faithful to a real source-level decision, not
   an oversight to "clean up" during porting.

   Proposed submodule layout (`rust/mover/src/move_to/`, built as a
   directory from the start — no flat 2,700-line file at any point):
   - `types.rs` — `MoveStrategy`, this file's own `Axis`, `MoveToOptions`
     (the large options struct), `CorrectionPass`, `MovePassDiagnostic`,
     `MoveToResult`, `MoveLearnSample`.
   - `correction_math.rs` — the pure, already-well-tested helpers:
     `clamp`, `pick_nearest_plausible_match`, `cap_correction_mickeys`,
     `clamp_mickeys_to_screen`, `should_abort_blind_corrections`,
     `pick_bail_pass`, `is_stale_template_match`. Maps directly to
     `move-to.pickBailPass.test.ts` + `move-to.staleMatch.test.ts`.
   - `template_cache.rs` — `get_cached_templates`, `maybe_persist_template`
     (thin client-taking wrappers over `template_set`'s already-ported
     load/persist/migrate functions).
   - `origin.rs` — `make_locator_deps`, `discover_origin` (glue over
     `CursorLocator` + `anchor_cursor`, per `discoverOrigin`'s own
     comment: both already exist).
   - `motion_diff.rs` — `detect_motion` (the ~270-line cluster-pairing
     core of the legacy correction loop; pure given decoded frames,
     independently testable). Maps to `move-to.detectMotion.test.ts`
     (26 cases, the single biggest test file here).
   - `wiggle_verify.rs` — `ml_wiggle_verify`, `wiggle_verify_candidate`,
     `try_open_loop_shape_detect`.
   - `pointer_accel_bridge.rs` — `learned_ballistics_enabled`,
     `learned_ballistics_px_per_mickey` — stubbed/deferred per the gap
     above, isolated in its own file specifically so the opt-in path
     doesn't entangle with the default path's files.
   - `legacy_move.rs` (name tentative) — `moveToPixel`'s own body for
     the non-curve-one-shot strategies: option resolution, ballistics
     profile lookup, calibration probe, open-loop emission, the
     open-loop landing cascade (motion→template→shape→predicted), the
     correction-pass loop (gross + linear regimes, blind-pass circuit
     breaker, oscillation guard, icon-tolerance exit, linear bailout),
     bail-to-best-pass, the V8 authoritative fallback, result-message
     assembly. Maps to `move-to.correctionCascade.test.ts` (the N1 bug
     regression), `move-to.verificationLag.test.ts`, and the
     `forbidSlam`/`forbidSlamOnIpad` tests (though those may turn out
     largely redundant with `cursor_anchor.rs`'s own guard tests now —
     confirm overlap before faithfully re-porting both). Flagged as the
     single largest remaining file even after this split (likely still
     600-900 lines) — may need further internal splitting once real
     line counts are known during implementation; not committing to a
     final shape before writing code against it.
   - `move_to.rs` (root) — the `curve-one-shot` dispatch (trivial: one
     `if`, delegates to `curve_mover::move_by_curve_one_shot`) + mod
     declarations + re-exports, mirroring every other root file this
     session's file-structure work has produced.

   Not yet decided, deferred to implementation time: whether
   `legacy_move.rs`'s while-loop is better left as one function (matches
   its own tight internal state-threading — many local variables read
   and mutated across the whole loop) or whether the landing-cascade and
   the loop-body are separable without an awkward parameter-passing
   seam. Judgment call for whoever implements it, informed by how it
   actually reads once transcribed, not decided in the abstract here.

   **v17 resolution (2026-08-29, georgs-mac-mini) — read `moveToPixel`'s
   full 1,245-line body (line 1467-2711) before writing any code, per
   the same rule.** `origin.rs` (discoverOrigin/makeLocatorDeps) is done
   and merged; the remaining split is between five files
   (`correction_math`/`template_cache`/`motion_diff`/`wiggle_verify`/
   `pointer_accel_bridge`, dispatched to nixos-dev) and `legacy_move.rs`
   (kept, alongside `origin.rs`, since `discoverOrigin`'s result threads
   directly into the whole correction loop).

   Judgment call on `legacy_move.rs`'s own internal shape: the
   correction-pass `while(true)` loop genuinely is NOT cleanly
   separable from the open-loop landing cascade that precedes it — both
   read and mutate the same ~15 local variables (`currentPos`,
   `prevPos`, `prevShot`, `observedRatioX/Y`, `passesSinceLastVerification`,
   `lastTemplateMatch`, `diagnostics`, `corrections`, `totalPasses`,
   `linearEntered`, etc.) in one continuous sequence. Threading that
   many fields through a shared mutable context struct across multiple
   files would relocate the coupling, not reduce it — an "awkward
   parameter-passing seam" exactly as flagged above, and the kind of
   decomposition-for-line-count-optics CLAUDE.md's "best practice, not
   quick hacks" rule exists to rule out. Two pieces of `moveToPixel` ARE
   genuinely separable — pure functions of already-finalized state, no
   back-coupling into the loop:
   - Option resolution (the `const x = options.foo ?? default` block +
     ballistics-profile freshness check, ~L1487-1560) → its own
     `resolved_options.rs`, unit-testable with no client/async at all.
   - Bail-to-best-pass + the V8 authoritative fallback + the
     `parts.join(' ')` message assembly + `MoveToResult` construction
     (the tail, ~L2590-2711) → its own `finalize.rs`, same shape.
   Everything between them — calibration probe, open-loop emission +
   landing cascade, and the correction-pass loop itself — stays as ONE
   function in `legacy_move.rs`, matching the TS reality (the original
   code never split it internally either, for the same real-coupling
   reason). Estimated ~900-1,100 lines once transcribed with Rust error
   handling/doc comments; still the single largest file in the port,
   consistent with v13's own "may need further internal splitting"
   caveat turning out NOT to apply once the actual coupling was read in
   full, not assumed.

   **Open discrepancy, not yet resolved**: this doc and my own proposal
   message both said 5 files dispatched to nixos-dev; the manager's
   confirmation (2026-08-29 04:02) says 4. Which one was held back is
   unconfirmed as of this entry — flagging here rather than guessing,
   since `origin.rs`'s `get_cached_templates` STOPGAP specifically
   depends on `template_cache.rs` landing.
6. **MCP protocol surface** (~3,100 LOC: `index.ts` — 2,575 LOC, the tool
   registry/dispatch, plus `cli.ts`, `http-server.ts`, `prompts/*`) — built
   LAST, on top of everything above, using `rmcp` per §6. `index.ts`'s size
   reflects ~90 MCP tool definitions with real validation logic per tool,
   not incidental bulk — expect this to be a genuinely large task even
   though it's "just" protocol glue.

   **Correction (2026-08-28, nixos-dev) — exact tool count, from an
   exhaustive read of `index.ts`, not the estimate above**: `toolRegistry`
   holds **37** entries (its own in-file comment claiming "32" is stale),
   3 of them gated off entirely unless `PIKVM_MOVER_LEARN=1`. Separately,
   `prompts/skill-tools.ts` generates one `skill_*` tool per entry in
   `allPrompts` (22 today) — not counted in the 37, dispatched via a
   `name.startsWith('skill_')` check that bypasses `toolsByName` entirely.
   Plus the unprefixed `login` tool (only present when a `LoginGate` is
   passed to `createMcpServer`). Of the 37, **34 have real Rust backing
   today**; the other 3 (`pikvm_health_check`, `pikvm_mouse_move_to`,
   `pikvm_mouse_click_at`) need `health-check.ts` (module 5's own
   remaining item) and `move-to.ts`'s `moveToPixel` (parked — its pieces
   are scattered across `cursor_anchor.rs`/`cursor_locator.rs`/
   `template_set.rs` but never assembled as a top-level function).
   `pikvm_mouse_scroll`'s optional pane-targeting pre-move shares that
   same gap but its core wheel-scroll works standalone.

   **Design decision (2026-08-28, nixos-dev), recorded per this section's
   own hand-rolling-justification rule**: `index.ts` does NOT use zod — it
   hand-validates args with permissive clamp-not-reject/default-not-reject
   semantics (`validateNumber` clamps to bounds rather than rejecting
   out-of-range, `validateEnum` silently falls back to a documented
   default rather than throwing) via a flat name-keyed `toolRegistry`
   array, not a schema library. `rmcp`'s `#[tool_router]`/`#[tool]` macros
   generate STRICT schemas via `schemars` from typed `Parameters<T>`
   extractors — the opposite semantics, and would reject inputs the TS
   server has always accepted. The Rust port (`pikvm-mcp-server` crate,
   `tools.rs`/`server.rs`) implements `ServerHandler::list_tools`/
   `call_tool` BY HAND instead, keeping `index.ts`'s own manual-registry
   shape (raw JSON Schema + a name→entry map) — using `rmcp` for what this
   section actually calls out as worth not hand-rolling (JSON-RPC framing,
   session management, SSE transport), not its schema-generation sugar.

   **Phase A shipped (2026-08-28, nixos-dev, `rust-port/module-3-cursor-
   locator-anchor` — the branch name predates this task but is where the
   whole session's work has landed)**: a real, working `pikvm-mcp-server`
   binary over the stdio transport — `ServerHandler` skeleton (`server.rs`)
   with the busy-lock gate, the login-gate scaffold (always `None` until
   `http-server.ts` lands), and the central sanitize-and-catch error path,
   plus 8 of the 34 assemblable tools (`pikvm_version`,
   `pikvm_get_resolution`, `pikvm_type`, `pikvm_key`, `pikvm_shortcut`,
   `pikvm_screen_state`, `pikvm_screenshot`, `pikvm_snapshot`). Verified
   end-to-end against the real built binary (a scripted stdio JSON-RPC
   session: initialize, tools/list, tools/call success/validation-error/
   unknown-tool paths, prompts/list, prompts/get against a real
   `docs/skills/*.md` file), not just unit tests. Remaining phases: B (the
   other 26 assemblable tools, mechanical repetition of the same pattern),
   C (`http-server.ts`: axum + Basic/kvmd auth + the login gate +
   `skill_*` dynamic tools), D (`health-check.ts` + explicit stubs for the
   3 blocked tools).

Total: ~22,000 non-test LOC across 61 files (grown since Part I's 19,083/48
count — the codebase kept moving during this same investigation, e.g. #51's
hid-latch-monitor family, cursor-anchor.ts's unification). Re-measure before
committing to a final schedule; don't treat either snapshot as frozen.

## 8. E2E validation plan — re-earning historically-hardware-only coverage

**A green Rust test suite is necessary, not sufficient.** This session's own
history is the evidence: multiple production-affecting bugs shipped with
fully green offline tests and were caught only by live iPad-rig hardware
testing. A port that validates itself only against a ported test suite will
reproduce this pattern — it inherits the ASSERTIONS but not the discipline
that found what needed asserting in the first place. The Rust implementation
must re-earn hardware confidence independently, the same way the TypeScript
implementation did, not inherit it by association.

**Mandatory risk categories, named explicitly rather than "run the test
suite"**:

1. **Mover/cursor-detection safety logic.** Specifically: N1's
   correction-loop dead-exit (task N1, this session — an outer-scoped
   `break` that skipped bookkeeping on ML-recovery, only found via a live
   click-bench + a paired iPadCollector ground-truth bench showing the bug
   reproduced 100% of the time it fired). The Rust port's E2E validation
   must include the equivalent of that gate: a live click-bench (N≥20,
   this project's negotiated minimum below its usual N≥80) AND a paired
   iPadCollector ground-truth bench, on the SAME kind of real targets,
   comparing against the current TypeScript implementation's own numbers
   as the baseline — not just "clicks land somewhere reasonable."
2. **cornerTargetFromBounds / anchor-verification logic** (referred to in
   the task as "F6/F8" bugs — cursor-anchor.ts's unification history). The
   deterministic ~619px corner-target bug (comparing against the raw HDMI
   frame corner instead of the iPad's own detected letterboxed-content
   corner) passed offline tests for months before a live gate caught it
   with a positive AND negative control on real hardware. The Rust E2E plan
   must include an equivalent positive/negative control pair: verified:true
   at a genuine correct-corner landing, verified:false at a genuine
   deliberately-short slam — both on real hardware, not simulated.
3. **HID recovery edge cases** (the #51 stale-settle-latch incident and
   related: a one-way `settling` flag cleared by exactly one caller, never
   re-evaluated on release, causing an indefinite latch — found via a real
   HID-mode-switch gate, not offline tests). The Rust port's HID-recovery
   layer (§7 layer 5) needs its own live gate: force a real mode switch,
   confirm the gate releases within the expected window without a restart,
   across at least the specific failure shape #51 exhibited.
4. **PR #93's cascade hint-narrowing / search behavior** (task_484bed055820).
   Re-run the same three-part live gate this session already proved out:
   (a) an isolated detection-call test confirming a good hint is faster
   with equivalent accuracy to no-hint, (b) a negative control confirming a
   deliberately bad/stale hint still falls back to a full scan and finds
   the real cursor, (c) a real on-box before/after latency measurement — not
   against the TypeScript baseline this time, but confirming the Rust
   implementation's own hint-narrowing achieves comparable behavior to what
   PR93 already validated.
5. **Hardware-gate harnesses must check FINAL device state, not just the
   first step's — and a `CallerAsserted`-shaped guard's safety claim must
   hold for the ACTUAL target, not the target the harness author assumed**
   (georgs-mac-mini, 2026-08-28, `cursor_anchor.rs`'s live gate). A smoke
   test (`cursor_anchor_smoke.rs`) reported "ALL GATES PASSED" — verified:
   true from phase 1's slam — while the iPad ended up on a Touch ID
   lockout prompt after phase 2's second slam+nudge, because nothing
   checked device state after the LAST action. Root-caused (via source
   comparison, not guesswork): NOT a `cursor_anchor.rs`/port bug — the
   guard mechanism worked exactly as designed throughout (`BoundsGuard`
   correctly refused against a genuine iPad target moments earlier, iPad
   confirmed untouched via before/after screenshots). The smoke test's
   OWN `CallerAsserted` reason asserted safety *because* the target was
   "confirmed awake/unlocked" — backwards from the guard's actual
   contract (both `cursor-anchor.ts:62` and the faithfully-ported
   `cursor_anchor.rs:79-81`: "a lock screen has no active hot corner"),
   and from the real production callers' own reason strings
   (`unlockIpad`: "lock screen has no active hot corner"; `ipadGoHome`:
   "safe on lock screen and home screen, idempotent") — both assert
   safety *because* the target is a lock screen, not despite it.
   `CallerAsserted` never refuses on the safety question by design; a
   caller that asserts safety for a context it doesn't actually hold gets
   exactly what it asked for. Two takeaways for the Rust E2E plan: (a)
   any harness driving a multi-step live sequence must capture and the
   operator must inspect a screenshot of the FINAL state, not just verify
   the first step's result, before trusting a "PASSED" line — this
   project deliberately has no automated lock-screen classifier (a prior
   heuristic was removed for false positives; lock-state determination is
   the operator's job via visual inspection); (b) the live positive-path
   gate for `CallerAsserted`-on-lock-screen was deliberately DEFERRED
   rather than forced (two real Touch-ID-lockout recoveries in one
   session already, a documented escalating-risk pattern on this rig) —
   its natural home is `ipad-unlock.ts`'s own future hardware gate (lock
   the iPad, run the real `unlockIpad`/`ipadGoHome` flow, confirm
   recovery), which exercises this exact code path in its real production
   context instead of an isolated synthetic smoke test. **Flag this as a
   requirement when ipad-unlock.ts's gate comes up**: that gate must
   include a genuine `CallerAsserted`-on-lock-screen positive-path run.
6. **`curve_mover.rs`'s own live gate: PASSED** (georgs-mac-mini,
   2026-08-29) — the actual THE-mover-is-solved iPad-critical path,
   `move_by_curve_one_shot`, run live against the real iPad via
   `curve_mover_smoke.rs`. Detected the cursor (via a faded-cursor wake —
   the pointer was faded at start, exercising that mechanism for real,
   not just its mocked unit tests), emitted the deterministic curve-based
   burst, and verified the landing: 6.7px residual (950,400 target →
   956,403 detected), matching the ~9px median this mover was originally
   validated at in TS. Confirmed visually, not just from the numeric
   result — the orange cursor arrow is clearly visible at the landing
   position in the saved screenshot.
   One reusable operational gotcha, not a port bug: the first run failed
   with "Cascade disabled — model file not found" —
   `resolve_verifier_model`'s bundled/cwd-relative resolution doesn't
   find `ml/crop-heatmap.onnx` from a `cargo run` invoked inside `rust/`
   (the model lives at the repo root, one level up). Fixed by setting
   `PIKVM_ML_VERIFIER_MODEL` explicitly for the run. Worth keeping in
   mind for every future example/gate invoked from `rust/` — and
   eventually for the real packaged deployment's own path resolution,
   which is pikvm-nixos's call, not decided here.
7. **`legacy_move.rs`'s own live gate: PARTIAL — ran correctly end-to-end,
   but caught a real (TS-inherited, not port-introduced) false-pairing
   bug via screenshot inspection** (georgs-mac-mini, 2026-08-29) — via
   `legacy_move_smoke.rs`, `strategy=detect-then-move` +
   `forbidSlamFallback=true` against the live iPad (target 1050,850).

   **Scope, decided before running**: this path's real production
   default is desktop/absolute-mouse (`docs/rust-port-plan.md` v13); its
   own live gate belongs on `it-03400`, a separate appliance this node
   has no access to (`docs/adr/0002-...md`: "it-03400's OTG link doesn't
   enumerate"). `slam-then-move` was therefore never exercised here —
   `forbidSlamFallback=true` makes any detect-then-move failure throw
   instead of falling back to slam, so this run structurally cannot
   reach the hot-corner-risk code path. What it DOES exercise for real:
   origin discovery (`locate_cursor`), the calibration probe, open-loop
   emission, and the full open-loop/correction-pass detection cascade
   (motion-diff achromatic filtering, ML-recovery, template fallback) —
   all fired genuinely against the live iPad per the run's own verbose
   log.

   **The finding**: the run completed without crashing (5 gross
   correction passes, budget-exhausted exit) and self-reported
   `final_detected_position=(1092,979)`, residual 135.7px. Per the
   screenshots-are-source-of-truth rule, saved and inspected the final
   frame BEFORE trusting that number — and it's wrong. Cropping the
   saved 1920×1080 frame at (1092,979) shows only dock icons (Notes/
   Settings/app-drawer), no cursor. The REAL cursor (orange arrow,
   confirmed visually) is sitting on the App Store icon at
   approximately (1045,690) — a real ~160px miss from the (1050,850)
   target, but nowhere near the algorithm's own claimed landing.

   **Root cause, read from the run's own verbose trace**: the final
   correction pass's `detect_motion` picked a pair whose post-cluster
   sits at (1092,979) — nearly identical to an EARLIER pass's own
   post-cluster at (1085,981), with a different, real ML-recovered
   position (1020,662) observed in between. `wouldRejectAsStationary`
   (the belief's static-feature lock-in guard) only compares a new
   candidate against the SINGLE most recent observation — it caught
   nothing here because the immediately-preceding observation (662) was
   genuinely different, even though an EARLIER one (981) matches almost
   exactly. This is the guard's own documented scope (single-prior-
   observation, not full history) in both the TS source and this port —
   faithfully reproduced, not a new defect introduced during porting.
   Consistent with, and now a concrete hardware-confirmed instance of,
   the legacy path's already-known lower reliability vs. the validated
   `curve-one-shot` default (CLAUDE.md: "old iterative mover" ≈73px
   median vs. curve-one-shot's ≈9px).

   **What this run does and doesn't prove**: proves the port compiles
   and runs correctly end-to-end against real hardware, with real
   detection cascades firing as designed, AND that the port faithfully
   reproduces the TS source's actual behavior — including its known
   weaknesses, not just its successes. Does NOT prove (and N=1 was never
   the goal here, per the standing no-verdicts-from-small-samples rule)
   any accuracy claim for this path, and does NOT cover slam-then-move
   or real absolute-mouse/desktop behavior — that gap stays open pending
   `it-03400` access. Not a merge blocker in itself (the finding is a
   faithful-port confirmation, not a regression), but worth a maintainer
   decision on whether the stationary-lock-in guard's scope should
   eventually be widened — flagged here, not silently fixed, since that
   would be a behavior change beyond this port's own faithful-port
   mandate.
8. **N=80 live click-bench: task_9bb80e84c948's own mandate, PASSED —
   80/80 (100%) verified, residuals 1.5-5.7px** (georgs-mac-mini,
   2026-08-29, `click_at_n80_bench.rs`). Real production path
   (`click_at()`, safety gates included, `strategy='curve-one-shot'`)
   against the real iPad, target = Settings icon. N=80 chosen over the
   task's own stated N≥20 floor per this project's stricter standing
   rule (noise floor ±10pp at N=20) — manager-approved before running.

   **Target re-measurement, not reuse-by-assumption**: the established
   bench protocol (`2026-05-11-phase-262-current-click-rate-bench.md`)
   used Settings at (905, 800). A fresh health-check screenshot taken
   immediately before this run showed the home-screen layout has
   visibly changed since May (widgets added, icon grid shifted) — the
   stale coordinate was confirmed off by ~120px via direct pixel
   analysis on the live frame. Used the re-measured real coordinate,
   (1027, 820), instead of trusting the old number. Manager's own
   instruction ("confirm the exact established icon... don't guess")
   is what prompted the re-measurement in the first place.

   **Result**: every one of 80 trials (go-home → `click_at` → verify →
   record) reported `verified=true`, residuals clustering at 1.5-5.7px —
   at or better than the TS baseline's own established curve-one-shot
   numbers (~98-99% production click-success, median ~9.1px, N=80,
   `movement-accuracy-plan.md` 2026-07-20). Zero failed trials, so no
   "every verified:false trial" screenshots existed to inspect (per the
   manager's own condition) — instead visually inspected a spread of 5
   samples across the full run (trials 5/20/40/60/80, saved as a "every
   5th trial" periodic sample): all 5 show the real Settings app open
   (specifically its "Home Screen & App Library" pane — consistent
   with Settings remembering its last-viewed subpage across launches,
   not evidence of anything wrong) with the orange cursor visibly
   inside it. A clean, screenshot-confirmed pass, not just a trusted
   number.

   **Explicitly NOT covered by this bench** (tracked as its own
   follow-up task, not silently dropped): paired iPadCollector
   ground-truth. `click_at`'s own pre/post-click screenshot diff is the
   real production signal `pikvm_mouse_click_at` gives a caller, but
   it's not an independent ground-truth source — it can't catch "the
   diff and the mover's self-report both agree but both are wrong" the
   way iPadCollector's `getCursor` would (the exact class of bug item 6
   above caught by screenshot alone). Also surfaced mid-scoping:
   iPadCollector is architecturally a WS **server** this process would
   have to host (with the iPad app connecting IN, not the reverse) —
   real infrastructure, correctly scoped out of today's regression
   check rather than silently assumed away.

**Structural requirement, not just content**: per §7's build-then-validate
sequence, each layer's live validation should happen as that layer lands,
not deferred to one big validation pass at the end — the same "validate a
component *when it's testable*, don't wait for a from the whole system"
discipline that already caught the four incidents above during layer-by-
layer development of the CURRENT TypeScript implementation. A big-bang
*build* strategy (ADR-0002) does not mean a big-bang *validation* strategy;
those are independent choices and this doc explicitly does not couple them.

**Owner of this validation, when it comes time to execute it**: the iPad
rig is real, physical hardware with no simulated equivalent — this work
belongs to whichever node owns live behavioral gating when Rust code is
ready to test (currently `pikvm-mcp-server@georgs-mac-mini`'s role for the
existing TypeScript implementation). Not scheduling that work now — this
section defines WHAT must be re-validated and WHY, not WHEN, since no Rust
implementation code exists yet to validate (this task is planning only,
per ADR-0002 and the task's own explicit scope).

---

**§8 execution update (2026-08-29, georgs-mac-mini)** — per the split agreed
with nixos-dev (they write categories 3/4 + the real-transport gate given no
hardware access from their environment; georgs-mac-mini executes everything
against the physical rig, plus owns categories 1/2/5 end to end):

9. **Real-transport gate for `pikvm_mouse_move_to`/`pikvm_mouse_click_at`
   (the manager's explicit §8 addition): RUN, PASSED.**
   `move_to_click_at_mcp_smoke.rs` (cherry-picked from nixos-dev's branch,
   commit 96d53b0, onto `rust-port/module-4-mover`) spawned the REAL
   `pikvm-mcp-server` binary as a child process, completed a real `initialize`
   handshake over real stdio JSON-RPC, and called `pikvm_mouse_move_to` via a
   real `tools/call` — landed 10.8px from target (956, 536). Visually
   confirmed via the tool's own returned screenshot: the orange cursor is
   clearly on the intended UI element. This is the first time this session
   the tool-registration/arg-parsing/dispatch layer itself (not just
   `move_to_pixel` called directly) was proven against real hardware.
10. **Category 4, PR93 cascade hint-narrowing: RUN, PASSED.**
    `cascade_hint_narrowing_smoke.rs` (cherry-picked, commit f6517a6) against
    the real `find_cursor_by_v8_full_frame`: no-hint baseline 1305ms; good
    hint (cursor's own just-detected position) narrowed to 151ms, 2.2px
    drift from baseline (same real cursor); bad-hint negative control
    (opposite frame corner) correctly fell back to a full scan (1106ms, ~=
    baseline cost) and still found the REAL cursor (1.4px drift from
    baseline, not the wrong hint location). Visually confirmed against the
    saved final frame — reported position matches the visible cursor.
11. **Category 3 (hid_settling_gate_smoke.rs, the #51 stale-settle-latch
    incident): BLOCKED, not run.** Requires a reachable `PIKVM_HIDMODE_URL`
    for a real, disruptive `POST /hidmode` mode switch. `$PIKVM_HOST/api/
    hidmode` 404s — per this node's own prior findings the real endpoint
    (`pikvm-hidmode-endpoint`, 127.0.0.1:8083) is on-box only, behind a
    front-door `pikvm-nixos@georgs-mac-mini` owns, not exposed to this
    environment. Not guessing at a URL for a disruptive mode-switch test —
    flagged to the manager for the right endpoint or a routing decision
    rather than silently skipped.

Remaining open work (categories 1/2/5, georgs-mac-mini's to execute):
category 2 (cornerTargetFromBounds genuine short-slam negative control, not
yet produced on the Rust port — only a guard-refusal exists so far, which is
a different signal than "slam attempted, landed short, verified:false");
category 5 (`ipad_unlock.rs`'s own live gate, specifically the genuine
`CallerAsserted`-on-lock-screen positive path §8 item 5 explicitly deferred —
no gate for this exists yet); category 1 (paired iPadCollector ground-truth,
tracked separately as task_37374b4bce6d, real new infra, not started).
Sequencing sanity-checked with the manager before running the higher-risk
pieces, given this rig's own documented Touch-ID-lockout pattern under heavy
slam/lock testing.
