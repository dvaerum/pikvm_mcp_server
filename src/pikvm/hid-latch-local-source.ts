/**
 * LOCAL sample-source for the HID-latch monitor — the appliance-native read.
 *
 * Runs ON the pikvm-nixos appliance as a systemd service (no Mac/SSH/key/sops):
 * it reads local sysfs directly and hands the classifier a composite `healthy`
 * boolean. Two silicon-measured constraints from it-03400 shape it:
 *
 * 1. COMPOSITE HEALTH keyed on `/sys/class/udc/<udc>/function`, NOT configfs.
 *    `/sys/class/udc/<udc>/state` is BLIND to a full gadget teardown — it reads
 *    `not attached` whether the gadget is bound-but-idle OR fully unbound (the #48
 *    class: kvmd-otg never started, gadget dir never created). `function` is
 *    non-empty exactly when a gadget is bound, so `healthy = BOUND (function
 *    non-empty) AND state ∈ acceptable`. Keying on function (not configfs) is
 *    deliberate: the #48 gadget dir is ENOENT, and reading configfs there would
 *    throw → the naive path would report the MOST-dead box as merely "unreachable"
 *    (a vacuous source_error). configfs is corroboration ONLY, for the `detail`
 *    string; its absence never produces a source_error. A genuine source_error is
 *    `/sys` itself unreadable.
 *
 * 2. REENUM is BOOT-SCOPED ONLY. The appliance has no RTC → pre-NTP kernel
 *    timestamps are months stale until sync → `journalctl --since` SILENTLY
 *    under-counts, pushing thrashing→latched (wrong rung). So the count is
 *    `journalctl -k -b` (this boot) with NO time window; windowing is the
 *    classifier's delta-between-samples job. The structure is FIXED (only the grep
 *    PATTERN is configurable) so `--since` can't be reintroduced by config.
 */
import { execFile } from 'node:child_process';
import { readFile as fsReadFile, readdir as fsReaddir } from 'node:fs/promises';
import type { SampleSource, SourceReading } from './hid-latch-runner.js';

/** Injectable local reads, so the composite + traps are unit-tested without real sysfs. */
export interface LocalLatchDeps {
  /** Read a file's text; REJECTS on missing/unreadable (ENOENT etc.). */
  readFile: (path: string) => Promise<string>;
  /** List a directory; REJECTS if unreadable. */
  listDir: (path: string) => Promise<string[]>;
  /** Count `journalctl -k -b` kernel lines containing `pattern` (boot-scoped, no --since). */
  reenumCount: (pattern: string) => Promise<number>;
}

export interface LocalLatchSourceConfig {
  /** UDC name; default = first entry of `/sys/class/udc` (one on rpi4/zero2w, matches hid-recover.sh). */
  udc?: string;
  /** configfs gadget name for corroboration/detail; default `kvmd`. */
  gadget?: string;
  /** Fixed-structure grep pattern (env `PIKVM_LATCH_REENUM_PATTERN`); default the gadget bind line. */
  reenumPattern?: string;
  /** UDC states that are acceptable WHEN BOUND (bound-ness is the real gate); default both idle+active. */
  acceptableStates?: string[];
  deps?: Partial<LocalLatchDeps>;
}

export const DEFAULT_REENUM_PATTERN = 'bound driver configfs-gadget';
export const DEFAULT_GADGET = 'kvmd';
/** Both `configured` (active) and `not attached` (bound-but-nothing-plugged) are fine when bound. */
export const DEFAULT_ACCEPTABLE_STATES = ['configured', 'not attached'];

const defaultDeps: LocalLatchDeps = {
  readFile: (p) => fsReadFile(p, 'utf8'),
  listDir: (p) => fsReaddir(p),
  reenumCount: (pattern) =>
    new Promise((resolve, reject) => {
      // Boot-scoped ONLY (`-b`), no `--since` — count matching lines in JS (no grep exit-1 quirk).
      execFile('journalctl', ['-k', '-b', '--no-pager'], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return reject(err);
        resolve(String(stdout ?? '').split('\n').filter((l) => l.includes(pattern)).length);
      });
    }),
};

export function makeLocalLatchSource(cfg: LocalLatchSourceConfig = {}): SampleSource {
  const deps = { ...defaultDeps, ...cfg.deps };
  const gadget = cfg.gadget ?? DEFAULT_GADGET;
  const pattern = cfg.reenumPattern ?? DEFAULT_REENUM_PATTERN;
  const acceptable = cfg.acceptableStates ?? DEFAULT_ACCEPTABLE_STATES;
  const configfsUdcPath = `/sys/kernel/config/usb_gadget/${gadget}/UDC`;

  let resolvedUdc: string | undefined = cfg.udc;
  let lastRawReenum = 0;

  return {
    async read(): Promise<SourceReading> {
      // Resolve the UDC once (one per board). listDir failing/empty ⇒ /sys is gone = source_error.
      if (!resolvedUdc) {
        let entries: string[];
        try {
          entries = await deps.listDir('/sys/class/udc');
        } catch (e) {
          return { ok: false, error: `/sys/class/udc unreadable: ${(e as Error).message}` };
        }
        if (entries.length === 0) return { ok: false, error: '/sys/class/udc is empty (no UDC)' };
        resolvedUdc = entries[0];
      }

      // function + state are the primary signals; a read fault here = genuine source_error.
      let functionVal: string;
      let state: string;
      try {
        functionVal = (await deps.readFile(`/sys/class/udc/${resolvedUdc}/function`)).trim();
        state = (await deps.readFile(`/sys/class/udc/${resolvedUdc}/state`)).trim();
      } catch (e) {
        return { ok: false, error: `/sys/class/udc/${resolvedUdc} read failed: ${(e as Error).message}` };
      }
      const bound = functionVal !== '';

      // configfs = corroboration ONLY (for `detail`); ENOENT is the #48 case ⇒ BROKEN, NEVER source_error.
      let gadgetDirAbsent = false;
      try {
        await deps.readFile(configfsUdcPath);
      } catch {
        gadgetDirAbsent = true;
      }

      // reenum: best-effort; a read miss reuses the last value (never drops the latch signal).
      try {
        lastRawReenum = await deps.reenumCount(pattern);
      } catch {
        /* keep lastRawReenum */
      }

      // boot_id (reboot→unreliable guard); best-effort.
      let bootId: string | undefined;
      try {
        bootId = (await deps.readFile('/proc/sys/kernel/random/boot_id')).trim() || undefined;
      } catch {
        bootId = undefined;
      }

      const healthy = bound && acceptable.includes(state);
      const detail = !bound
        ? gadgetDirAbsent
          ? 'unbound (#48: no gadget dir)'
          : 'unbound (gadget torn down)'
        : state === 'configured'
          ? 'configured'
          : `${state} (bound)`;

      return { ok: true, healthy, rawReenum: lastRawReenum, bootId, detail, bound, state };
    },
  };
}
