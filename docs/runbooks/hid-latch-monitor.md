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
  - `latched` (count ≈ 0, flatlined/dead — a `not attached` flatline = Mode B) →
    **`udc-rebind`** (R3a). NOT `soft_connect`: for this exact signature on pikvm01,
    soft_connect was insufficient twice (2026-07-26 + 2026-08-08 — it left UDC
    `not attached`; only a UDC-rebind revived it), so the alert points straight at
    the rung that works and the `note` field says to expect to escalate.
  - `thrashing` (count high, re-enumerating but never settling — the metronomic
    ~3.15s pattern that PRECEDED the real 6.6-day latch) → **`power_cable`**: an
    under-volt storm (`vcgencmd get_throttled` had voltage bits set), which a UDC
    rebind will not fix. This storm case is a **true positive**, not noise.
- **A reboot mid-window ⇒ `classificationConfidence: 'unreliable'`.** `journalctl -k -b`
  resets on reboot (not just a ring wrap), while `downSince` survives (a reboot emits
  no healthy sample), so the count under-reports and would fake `latched` on a box
  whose real fault is electrical — a normal event on the under-volted pikvm01, where
  `power_cable` remediation *is* a power-cycle. The monitor reads `boot_id` on the same
  SSH round-trip; a change within the window sets `rebootedDuringWindow: true` and marks
  the split **unreliable** (the latch is still real, so the window is kept, but the
  rung recommendation must not be auto-acted on). Credit it-03400 for the catch.
- **`latchDurationMs` is a LOWER BOUND.** `downSince` anchors to the first *observed*
  non-healthy sample, so at the 60s baseline cadence the true onset can be up to a poll
  earlier. Don't quote it as the exact outage duration.

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

## The remote contract — FROZEN interface (`STATE=` / `REENUM=` / `BOOT=`)

The remote side (the bin's own one-shot script, OR a forced-command wrapper —
see below) MUST emit exactly this on stdout, or every poll silently becomes a
`source_error` (the same vacuous class as a wrong `PIKVM_LATCH_SSH_BIN`). This is
the interface the bin parses (`hid-latch-ssh-source.ts`); treat it as frozen.

- **Exit 0.** A non-zero exit makes the whole read a `source_error` regardless of
  stdout.
- **`STATE=<value>`** — parsed `/STATE=(.*)/` then trimmed: the raw
  `/sys/class/udc/<udc>/state` (`configured` / `not attached`, space and all).
  **Must be non-empty** — an empty/missing STATE is a `source_error`, NOT a silent
  "up".
- **`REENUM=<digits>`** — parsed `/REENUM=(\d+)/`: a plain integer, the cumulative
  enumeration-**attempts** count (`journalctl -k -b | grep -c 'new device is high-speed'`).
  A leading space / non-digit breaks the capture → the bin reuses the last-known
  value (classification degrades). Tolerated if missing, but emit it.
- **`BOOT=<hex-and-dashes>`** — parsed `/BOOT=([0-9a-fA-F-]+)/`:
  `/proc/sys/kernel/random/boot_id`. Missing just disables reboot-mid-window
  detection; emit it so `classificationConfidence` works.

Order-independent, one value per key, no trailing junk (only STATE is trimmed).

### Forced-command auth (the LaunchDaemon scoped key)

The deploy uses a least-privilege **scoped key** whose `authorized_keys` entry
pins a **forced command** (`command="…",restrict`). Under a forced command, sshd
**ignores the client-supplied command** (`$SSH_ORIGINAL_COMMAND`) and runs the
wrapper instead — so:

- The **wrapper on pikvm01 is the source of truth** for the remote-side commands
  (the UDC `state` read and the re-enum count); it must emit the frozen
  `STATE=`/`REENUM=`/`BOOT=` contract above.
- **`PIKVM_LATCH_REENUM_CMD` (and any remote-command override) is SILENTLY INERT**
  in this mode — the bin still sends its script, but sshd discards it. Anyone later
  "tuning the re-enum pattern" via that env var changes nothing and gets no error
  (same silent-no-op class as the vacuous ssh-path pass). Tune the pattern in the
  wrapper, not the env.

Evidence (falsifiable, on real HW — NOT the withdrawn `echo 999999`→0 reading,
which was a relative-counter null misread as a positive):

- **Transport-layer:** under the forced command, `ssh <host> whoami` / `'id; uname -a'`
  return ONLY the wrapper's `STATE=`/`REENUM=`/`BOOT=` lines — sshd discards the
  client-supplied command, so the bin's inline script (and every env-derived command
  in it) never runs.
- **Delta test (it-03400):** with `PIKVM_LATCH_REENUM_CMD='echo 5'` deliberately set,
  an injected +12 gave `reenumCountInWindow=12` → `thrashing`; had the env applied it
  would have been delta 0 → `latched`. The wrapper's value won — a control that could
  have failed, and didn't.

## Output — JSONL to stdout (the durable report)

One JSON object per line. pikvm-nixos routes StandardOutPath → the log.

| `kind` | when | fields |
|---|---|---|
| `tick` | on an up↔down transition, or a periodic heartbeat | `reason` (`transition`\|`heartbeat`), `t`, `state`, `up`, `reenumCount`, `down`, `downSince` |
| `alert` | once, when a down-window first crosses 90s | `firedAt`, `downSince`, `latchDurationMs`, `state`, `reenumCountInWindow`, `classification` (`latched`\|`thrashing`), `recommendedRung` (`soft_connect`\|`udc-rebind`\|`power_cable`), `note`, `rebootedDuringWindow`, `classificationConfidence` (`reliable`\|`unreliable`) |
| `source_error` | a read failed (SSH/parse) | `t`, `error`, `consecutive` |

(`tick.reenumCount` is the RELATIVE counter — the runner baselines it at its first
read and accumulates only positive deltas, so it starts near 0, not the box's
absolute since-boot value; only the in-window delta drives classification.)

Steady state is NOT logged every poll — only transitions, alerts, errors, and a
liveness heartbeat (~every 10 min at the 60s baseline). Two reading rules:

- **A quiet log is NOT proof of life.** The heartbeat bounds staleness but the
  authoritative liveness check is on the launchd side (the agent is `KeepAlive`);
  don't read a gap as "healthy" without confirming the process is alive.
- **A STAYS-QUIET result is valid ONLY if `source_errors == 0`.** With a wrong
  `PIKVM_LATCH_SSH_BIN` (e.g. the Mac's `/usr/bin/ssh` on a NixOS host) every read
  ENOENTs into `source_error`, the monitor is fed nothing, and it emits zero
  alerts — a vacuous pass indistinguishable from a real one unless you check the
  error count. (Caught by it-03400's negative-control run.)

## Configuration (env — launchd can tune without a rebuild)

| var | meaning | default |
|---|---|---|
| `PIKVM_HID_RECOVERY_SSH` | `[user@]host` of the PiKVM (**required**) | — |
| `PIKVM_LATCH_ESCALATED_MS` | escalated cadence (ms) — PROVISIONAL, pending manager sign-off | 5000 |
| `PIKVM_LATCH_BASELINE_MS` | baseline cadence (ms) | 60000 |
| `PIKVM_LATCH_PERSIST_MS` | persistence threshold (ms) | 90000 |
| `PIKVM_LATCH_REENUM_MAX` | reenum-in-window ≤ this ⇒ `latched` else `thrashing` | 2 |
| `PIKVM_LATCH_REENUM_CMD` | remote cmd printing a cumulative re-enum count | see below |
| `PIKVM_LATCH_HEALTHY_STATE` | the UDC `state` that is HEALTHY for **this** target | `configured` |
| `PIKVM_LATCH_SSH_BIN` | absolute path of the ssh binary to spawn (override only off-Mac) | `/usr/bin/ssh` |

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
