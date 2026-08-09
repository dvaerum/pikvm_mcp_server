# Runbook: pikvm01 HID-latch monitor (report-only v1)

Detects a HID **latch** — the emulated USB gadget stuck non-`configured` — that
[HID recovery](hid-recovery.md) would fix but nobody notices, because
`kvmd`/`kvmd-otg` stay `active` with `NRestarts=0` throughout. On pikvm01 this
latched HID dead for **6.61 days** with systemd green the whole time.

Backed by `src/pikvm/hid-latch-monitor.ts` (pure core), `hid-latch-runner.ts`
(headless poll loop), `hid-latch-ssh-source.ts` (SSH transport) and the
`pikvm-hid-latch-monitor` bin (`src/hid-latch-monitor-main.ts`). Report-only:
it **recommends** a recovery rung, it does not act (auto-recovery is a separate
later ruling).

## Why it can't live in the MCP server

The off-box WB-kiosk MCP is a **per-session stdio spawn** (Claude Code launches
it when the iOS project is open, SIGKILLs it on disconnect; no launchd agent
keeps it alive — verified against macos-nixos-setup @ c334cfc). An in-process
timer would be inert between sessions and dead through the multi-day outage it's
meant to catch. So the monitor is a **separate headless daemon**.

## Detection logic — alert on the LATCH, not the blip

Re-enumerations are NORMAL here (~2.4/h baseline, storms to ~32/h), each
self-healing in 1–3s. Naively alerting on `UDC != configured` fires hourly and
gets muted — manufacturing the exact silence we're removing. So:

- **Ground truth = the UDC `state`** (`/sys/class/udc/<udc>/state`), NEVER kvmd's
  online flags (they lie in both directions — on pikvm01 `online=False` persisted
  several seconds *after* a rebind had genuinely restored HID; the persistence
  window below rides over that transient rather than misreading a recovery as a
  continuing latch).
- **Healthy state is per-target, not a global truth.** `not attached` is the fault
  on pikvm01 (baseline `configured`) but the *correct* baseline on an uncabled box
  (e.g. it-03400's appliance reads `not attached` every boot) — a hardcoded
  `configured⇒healthy` would alert forever there. Set `PIKVM_LATCH_HEALTHY_STATE`
  per target; a sample equal to it resets the timer.
- **Persistence, not consecutive-count**: the timer resets on *any* observed
  `configured`; we alert only when non-`configured` persists **≥ 90s**.
- **Adaptive cadence**: baseline 60s; on the first non-`configured` sample the
  poll escalates to a finer interval so a storm can't slip a latch onset past a
  coarse grid.
- **Two faults, one alarm, different remediation** — the alert carries the
  re-enumeration count observed in the window:
  - `latched` (count ≈ 0, flatlined/dead) → **`soft_connect`** (R2), escalate
    `udc-rebind` (R3a).
  - `thrashing` (count high, re-enumerating but never settling — the metronomic
    ~3.15s pattern that PRECEDED the real 6.6-day latch) → **`power_cable`**: an
    under-volt storm (`vcgencmd get_throttled` had voltage bits set), which a UDC
    rebind will not fix. This storm case is a **true positive**, not noise.

## The escalated interval (aliasing turned out non-binding)

The invariant `escalatedIntervalMs ≤ shortest configured window` still holds and
is enforced by a test (`hid-latch-monitor.test.ts`), but on-box measurement showed
it is **not the binding constraint** it looked like: down-windows are **≤220ms**,
so the `configured` windows are the long stretches (seconds), and a poll landing
inside a recoverable blip is ~0.015% at baseline / ~1% mid-burst. The stays-quiet
arm is therefore near-guaranteed by physics at any 1–60s cadence. The interval
stays a parameter (default **5000 ms**, PROVISIONAL) pending the iPad node's 10ms
distribution + the manager's sign-off — it just no longer needs to be tiny.

A consequence worth stating: because down-windows are so short, the monitor is
effectively **blind to normal churn** — it only ever samples a sustained latch.
That's fine for the goal, but it's *why* the re-enum count cannot come from the
monitor's own samples and must come from the journal (below).

## Transport — SSH (not the HTTPS kvmd API)

A headless launchd agent has no macOS Local-Network privacy grant, so the
loopback-tinyproxy path the MCP's HTTPS API depends on isn't available. The
monitor reads the sysfs file over SSH, reusing `PIKVM_HID_RECOVERY_SSH`
(`root@pikvm01…`) with `BatchMode=yes ConnectTimeout=<n> StrictHostKeyChecking=yes`.

> **On-box check — DONE (2026-08-09, macOS 26.2).** SSH from a genuine launchd
> context is NOT blocked by Local-Network privacy — verified with a transient
> LaunchAgent (`PPID=launchd`) reaching 10.109.1.1 in 0s. **The hard constraint:**
> it works *only* because the connection is made by Apple's SYSTEM `/usr/bin/ssh`
> shelled out as a subprocess. The MCP's HTTPS block happened because a nix-store
> **node** binary connected IN-PROCESS. So the adapter MUST spawn the absolute
> `/usr/bin/ssh` (`DEFAULT_SSH_BINARY`) — never a node SSH library — and this is a
> **tested contract** (`hid-latch-ssh-source.test.ts`) because the failure would
> surface only on the Mac, never in the Linux test VM.

A transport failure (`ok:false`) is reported as a distinct `source_error` record
and **does not advance the latch timer** — an SSH/network/Mac outage can never
masquerade as a HID latch, nor hide one.

## Output — JSONL to stdout (the durable report)

One JSON object per line. pikvm-nixos routes StandardOutPath → the log.

| `kind` | when | fields |
|---|---|---|
| `tick` | on an up↔down transition, or a periodic heartbeat | `reason` (`transition`\|`heartbeat`), `t`, `state`, `up`, `reenumCount`, `down`, `downSince` |
| `alert` | once, when a down-window first crosses 90s | `firedAt`, `downSince`, `latchDurationMs`, `state`, `reenumCountInWindow`, `classification` (`latched`\|`thrashing`), `recommendedRung` (`soft_connect`\|`udc-rebind`\|`power_cable`) |
| `source_error` | a read failed (SSH/parse) | `t`, `error`, `consecutive` |

Steady state is NOT logged every poll — only transitions, alerts, errors, and a
liveness heartbeat — so a long healthy or long latched stretch stays greppable.

## Configuration (env — launchd can tune without a rebuild)

| var | meaning | default |
|---|---|---|
| `PIKVM_HID_RECOVERY_SSH` | `[user@]host` of the PiKVM (**required**) | — |
| `PIKVM_LATCH_ESCALATED_MS` | escalated cadence (ms) — **set from the down-duration measurement** | 1000 |
| `PIKVM_LATCH_BASELINE_MS` | baseline cadence (ms) | 60000 |
| `PIKVM_LATCH_PERSIST_MS` | persistence threshold (ms) | 90000 |
| `PIKVM_LATCH_REENUM_MAX` | reenum-in-window ≤ this ⇒ `latched` else `thrashing` | 2 |
| `PIKVM_LATCH_REENUM_CMD` | remote cmd printing a cumulative re-enum count | see below |
| `PIKVM_LATCH_HEALTHY_STATE` | the UDC `state` that is HEALTHY for **this** target | `configured` |

`PIKVM_LATCH_REENUM_CMD` default:
`journalctl -k -b --no-pager | grep -c 'new device is high-speed'`.

Two settled measurements drive that exact form:

- **Count ATTEMPTS, not completions.** `new device is high-speed` counts
  enumeration *attempts*; `new address` counts *completed* enumerations. A
  hard-thrashing box repeatedly attempts and never completes, so `new address`
  reads ~0 there — which would misclassify it as `latched` and recommend a
  UDC-rebind when the real fault is power. Attempts stay high in that state and
  classify it correctly. (Normal ratio ≈ 2.5:1 attempts:completions — magnitude and
  rate are the signal, not the ratio.)
- **journald, not `dmesg`.** On pikvm01 the dmesg ring has ALREADY wrapped after
  ~13 days of quiet operation (undercounting *today*, before any storm). journald is
  much better but not unbounded here (`Storage=volatile`, `/run`,
  `RuntimeMaxUse=100M` ≈ 29 days, sooner under storms), so the runner's
  monotonic-normalising backstop is **load-bearing**, not belt-and-braces.

An external count is REQUIRED (not a nicety): on-box measurement found every
re-enumeration shows only `not attached` at the visible resolution — the UDC
`state` field cannot itself tell a `latched` flatline from a `thrashing` storm, so
the latch/thrash split must come from this count.

> **v1.1 enhancement (deferred):** carry BOTH `attempts` and `completed` — an
> `attempts >> completed` divergence is the strongest positive evidence of *failing*
> enumeration (power fault) rather than an inferred-from-magnitude guess. v1 uses the
> single `attempts` count, which is sufficient for a correct latch/thrash split.

## Ownership / gates

- **pikvm-mcp-server@nixos-developer-system** (this repo): the TS above.
- **pikvm-nixos@georgs-mac-mini**: `launchd.user.agents.pikvm-hid-latch-monitor`
  (RunAtLoad + KeepAlive, StandardOutPath → the log), the on-box SSH-privacy
  check, the alarm sink.
- **pikvm-mcp-server@georgs-mac-mini** (the rig): the ship gate — **FIRES**
  (manufactured genuine latch `echo "" > …/UDC` → alert in 90–150s; rebind clears)
  and **STAYS QUIET** (zero alerts across a *measured* ~32/h storm window, not just
  a calm baseline).
