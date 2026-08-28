#!/usr/bin/env node
/**
 * `pikvm-hid-latch-monitor` — the HEADLESS entrypoint for the HID-latch monitor
 * (report-only v1). Runs the poll loop forever, emits JSONL to stdout, and (for the
 * appliance systemd deployment) writes an atomic status snapshot to a file the
 * appliance endpoint + MCP health_check read.
 *
 * TWO SOURCES (env `PIKVM_LATCH_SOURCE`, default `ssh`):
 *  - `local`  — appliance-native: reads local sysfs directly (systemd service, no
 *               SSH/key). Composite health keyed on the gadget's bound-ness.
 *  - `ssh`    — pikvm01: reads over SSH via the system /usr/bin/ssh.
 *
 * Config via env (launchd/systemd tune without a rebuild):
 *   PIKVM_LATCH_SOURCE        `local` | `ssh` (default `ssh`).
 *   PIKVM_HID_RECOVERY_SSH    [user@]host of the PiKVM (REQUIRED for `ssh`).
 *   PIKVM_LATCH_SSH_BIN       absolute ssh binary (default `/usr/bin/ssh`; override off-Mac).
 *   PIKVM_LATCH_REENUM_CMD    (ssh) remote cmd printing a boot-scoped re-enum count.
 *   PIKVM_LATCH_HEALTHY_STATE (ssh: one state; local: comma-separated ACCEPTABLE set).
 *   PIKVM_LATCH_UDC           (local) UDC name; default first of /sys/class/udc.
 *   PIKVM_LATCH_GADGET        (local) configfs gadget name (default `kvmd`).
 *   PIKVM_LATCH_REENUM_PATTERN (local) journalctl -k -b grep pattern (fixed `-b`, no --since).
 *   PIKVM_LATCH_STATUS_PATH   write the status JSON atomically here each poll (e.g.
 *                             /run/pikvm-hid-latch/status.json). Unset ⇒ no status file.
 *   PIKVM_LATCH_ESCALATED_MS / _BASELINE_MS / _PERSIST_MS / _REENUM_MAX  cadence/classify knobs.
 */
import { writeFileSync, renameSync } from 'node:fs';
import { HidLatchMonitor, type MonitorConfig } from './pikvm/hid-latch-monitor.js';
import { runMonitorLoop, type LatchStatus, type SampleSource } from './pikvm/hid-latch-runner.js';
import { makeSshLatchSource } from './pikvm/hid-latch-ssh-source.js';
import { makeLocalLatchSource } from './pikvm/hid-latch-local-source.js';

function numEnv(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`pikvm-hid-latch-monitor: ${name}=${JSON.stringify(v)} is not a number`);
    process.exit(2);
  }
  return n;
}

const cfg: Partial<MonitorConfig> = {};
const esc = numEnv('PIKVM_LATCH_ESCALATED_MS');
if (esc !== undefined) cfg.escalatedIntervalMs = esc;
const base = numEnv('PIKVM_LATCH_BASELINE_MS');
if (base !== undefined) cfg.baselineIntervalMs = base;
const persist = numEnv('PIKVM_LATCH_PERSIST_MS');
if (persist !== undefined) cfg.persistenceThresholdMs = persist;
const reenumMax = numEnv('PIKVM_LATCH_REENUM_MAX');
if (reenumMax !== undefined) cfg.latchReenumMax = reenumMax;

const sourceKind = (process.env.PIKVM_LATCH_SOURCE?.trim() || 'ssh').toLowerCase();
let source: SampleSource;

if (sourceKind === 'local') {
  const acceptable = process.env.PIKVM_LATCH_HEALTHY_STATE?.split(',').map((s) => s.trim()).filter(Boolean);
  source = makeLocalLatchSource({
    udc: process.env.PIKVM_LATCH_UDC?.trim() || undefined,
    gadget: process.env.PIKVM_LATCH_GADGET?.trim() || undefined,
    reenumPattern: process.env.PIKVM_LATCH_REENUM_PATTERN?.trim() || undefined,
    acceptableStates: acceptable && acceptable.length > 0 ? acceptable : undefined,
  });
} else if (sourceKind === 'ssh') {
  const host = process.env.PIKVM_HID_RECOVERY_SSH?.trim();
  if (!host) {
    console.error('pikvm-hid-latch-monitor: PIKVM_HID_RECOVERY_SSH ([user@]host) is required for source=ssh');
    process.exit(2);
  }
  source = makeSshLatchSource({
    host,
    reenumCountCmd: process.env.PIKVM_LATCH_REENUM_CMD,
    healthyState: process.env.PIKVM_LATCH_HEALTHY_STATE?.trim() || undefined,
    sshBinary: process.env.PIKVM_LATCH_SSH_BIN?.trim() || undefined,
  });
} else {
  console.error(`pikvm-hid-latch-monitor: PIKVM_LATCH_SOURCE=${JSON.stringify(sourceKind)} — expected 'local' or 'ssh'`);
  process.exit(2);
}

// Atomic status writer: temp + rename on the same fs, so a reader never sees a torn file.
const statusPath = process.env.PIKVM_LATCH_STATUS_PATH?.trim();
const onStatus = statusPath
  ? (status: LatchStatus): void => {
      try {
        const tmp = `${statusPath}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(status) + '\n');
        renameSync(tmp, statusPath);
      } catch (e) {
        // A status-write failure must not kill monitoring — surface it, keep going.
        console.error(`pikvm-hid-latch-monitor: status write failed: ${(e as Error).message}`);
      }
    }
  : undefined;

const monitor = new HidLatchMonitor(cfg);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

runMonitorLoop({ source, monitor, now: () => Date.now(), sleep, onStatus }).catch((err: unknown) => {
  console.error(`pikvm-hid-latch-monitor: loop crashed: ${(err as Error).message}`);
  process.exit(1);
});
