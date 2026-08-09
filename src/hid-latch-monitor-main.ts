#!/usr/bin/env node
/**
 * `pikvm-hid-latch-monitor` — the HEADLESS entrypoint for the pikvm01 HID-latch
 * monitor (report-only v1). Runs the poll loop forever and emits JSONL to stdout;
 * pikvm-nixos owns placing it under `launchd.user.agents` (RunAtLoad + KeepAlive,
 * StandardOutPath → the durable log). It speaks no MCP — deliberately separate
 * from the per-session stdio server, which is inert between sessions.
 *
 * Config via env (so launchd can tune it without a rebuild):
 *   PIKVM_HID_RECOVERY_SSH   [user@]host of the PiKVM (REQUIRED; reused from recovery).
 *   PIKVM_LATCH_ESCALATED_MS escalated sampling cadence (ms) — SET FROM the on-box
 *                            down-duration measurement (must be ≤ the shortest
 *                            `configured` window, or a coarse grid aliases a
 *                            recoverable storm into a false latch).
 *   PIKVM_LATCH_BASELINE_MS  baseline cadence (ms, default 60000).
 *   PIKVM_LATCH_PERSIST_MS   persistence threshold (ms, default 90000).
 *   PIKVM_LATCH_REENUM_MAX   reenum-in-window ≤ this ⇒ `latched` else `thrashing`.
 *   PIKVM_LATCH_REENUM_CMD   remote cmd printing a cumulative re-enum count.
 *   PIKVM_LATCH_HEALTHY_STATE  the UDC `state` that is HEALTHY for this target
 *                            (default `configured`; set to `not attached` for an
 *                            intentionally-uncabled box so it doesn't alert forever).
 *   PIKVM_LATCH_SSH_BIN      absolute path of the ssh binary to spawn (default the
 *                            Mac's system `/usr/bin/ssh`). Override ONLY to run where
 *                            that path is absent (e.g. NixOS test hosts) — otherwise
 *                            it silently ENOENTs into `source_error`, a vacuous pass.
 */
import { HidLatchMonitor, type MonitorConfig } from './pikvm/hid-latch-monitor.js';
import { runMonitorLoop } from './pikvm/hid-latch-runner.js';
import { makeSshLatchSource } from './pikvm/hid-latch-ssh-source.js';

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

const host = process.env.PIKVM_HID_RECOVERY_SSH?.trim();
if (!host) {
  console.error('pikvm-hid-latch-monitor: PIKVM_HID_RECOVERY_SSH ([user@]host) is required');
  process.exit(2);
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
const healthy = process.env.PIKVM_LATCH_HEALTHY_STATE?.trim();
if (healthy) cfg.healthyState = healthy;

const monitor = new HidLatchMonitor(cfg);
const source = makeSshLatchSource({
  host,
  reenumCountCmd: process.env.PIKVM_LATCH_REENUM_CMD,
  sshBinary: process.env.PIKVM_LATCH_SSH_BIN?.trim() || undefined,
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

runMonitorLoop({ source, monitor, now: () => Date.now(), sleep }).catch((err: unknown) => {
  console.error(`pikvm-hid-latch-monitor: loop crashed: ${(err as Error).message}`);
  process.exit(1);
});
