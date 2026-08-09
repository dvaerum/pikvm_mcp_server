/**
 * SSH sample-source for the HID-latch monitor — the transport half of the runner.
 *
 * Reuses the SAME `ssh [user@]host <remote>` idiom (BatchMode, ConnectTimeout,
 * operator's own SSH config/agent, no embedded key material) as the HID-recovery
 * SSH trigger in {@link ./hid-recovery}, and the same injectable {@link SshExec}
 * so it is unit-testable without a real network. Chosen over the HTTPS kvmd API
 * because a headless launchd agent has no macOS Local-Network privacy grant (the
 * loopback-tinyproxy the MCP relies on isn't guaranteed there) — reading the sysfs
 * file over SSH sidesteps that. NB: whether SSH from a launchd-spawned nix-store
 * binary itself trips Local-Network privacy is the FIRST on-box check.
 *
 * Reads two things per poll: the UDC `state` (the latch ground truth) and a RAW
 * cumulative-since-boot re-enumeration count (the classification signal, latch vs
 * thrash). State parsing is STRICT — a missing state is a source error — but the
 * re-enum count is LENIENT: a failed count read reuses the last known value rather
 * than suppressing the latch alarm, since only `state` decides whether we fire.
 */
import { execFile } from 'node:child_process';
import { UDC_UP } from './hid-latch-monitor.js';
import type { SampleSource, SourceReading } from './hid-latch-runner.js';

/**
 * Runs one remote command via a spawned SSH BINARY. The `bin` is explicit and
 * TESTED (not folded into the args) because the transport only works from a
 * launchd context when the connection is made by Apple's SYSTEM `/usr/bin/ssh`
 * shelled out as a subprocess — a node in-process SSH library would resurface the
 * macOS Local-Network privacy block, and that failure shows up ONLY on the Mac,
 * never in the Linux test VM. Injectable so parsing/idiom are unit-tested offline.
 */
export type SshLatchExec = (
  bin: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface SshLatchSourceConfig {
  /** `[user@]host`, from `PIKVM_HID_RECOVERY_SSH` (e.g. `root@pikvm01.bb.vcamp.dk`). */
  host: string;
  /**
   * Absolute path of the SSH binary to spawn. MUST be Apple's system `/usr/bin/ssh`
   * on the Mac — verified on-box that a launchd agent reaches the LAN PiKVM through
   * it, whereas an in-process store-binary connection is blocked by Local-Network
   * privacy. Pinned absolute (not PATH-resolved) on purpose.
   */
  sshBinary?: string;
  /**
   * Remote shell command that prints a CUMULATIVE-since-boot re-enumeration count
   * on stdout. Parameterised because the exact grep pattern is the iPad node's
   * measurement domain. A dmesg ring wrap is still normalised to a monotonic
   * counter by the runner, so this need only be monotonic BETWEEN wraps.
   */
  reenumCountCmd?: string;
  /**
   * The UDC `state` that means HEALTHY for this target — the source computes the
   * `healthy` boolean the (signal-agnostic) classifier consumes. Default `configured`
   * (pikvm01, a live HID target). Per-target because an uncabled box's baseline differs.
   */
  healthyState?: string;
  connectTimeoutS?: number;
  timeoutMs?: number;
  exec?: SshLatchExec;
}

/**
 * Counts enumeration ATTEMPTS (`new device is high-speed`), NOT completions
 * (`new address`) — measured/settled on pikvm01. This matters: a hard-thrashing box
 * repeatedly attempts enumeration and never COMPLETES, so a completion count reads
 * ~0 there and would misclassify a thrashing (power-fault) box as `latched`,
 * recommending a UDC-rebind when the real fix is power/cable — the exact misdiagnosis
 * the split exists to prevent. Attempts stay high in that state, so they classify it
 * correctly. (In normal operation attempts:completions ≈ 2.5:1, so the magnitude/rate
 * is the signal, not the ratio alone.)
 *
 * Uses the PERSISTED kernel journal, not `dmesg`: on pikvm01 the dmesg ring has
 * ALREADY wrapped after 13 days of quiet operation (undercounting today, before any
 * storm). journald is much better but NOT unbounded here (Storage=volatile, /run,
 * RuntimeMaxUse=100M ≈ 29 days, sooner under storms) — which is why the runner's
 * monotonic-normalising backstop is load-bearing, not belt-and-braces.
 */
export const DEFAULT_REENUM_COUNT_CMD =
  "journalctl -k -b --no-pager 2>/dev/null | grep -c 'new device is high-speed'";

/** Default SSH binary — Apple's system ssh (see {@link SshLatchSourceConfig.sshBinary}). */
export const DEFAULT_SSH_BINARY = '/usr/bin/ssh';

const defaultExec: SshLatchExec = (bin, args, opts) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: opts.timeoutMs }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err
            ? 255
            : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

export function makeSshLatchSource(cfg: SshLatchSourceConfig): SampleSource {
  const host = cfg.host.trim();
  if (!host) throw new Error('makeSshLatchSource: host is required (PIKVM_HID_RECOVERY_SSH)');
  const exec = cfg.exec ?? defaultExec;
  const sshBinary = cfg.sshBinary ?? DEFAULT_SSH_BINARY;
  const reenumCmd = cfg.reenumCountCmd ?? DEFAULT_REENUM_COUNT_CMD;
  const healthyState = cfg.healthyState ?? UDC_UP;
  const connectTimeoutS = cfg.connectTimeoutS ?? 5;
  const timeoutMs = cfg.timeoutMs ?? 8_000;

  // Resolve the UDC on-host (nothing hardcoded); emit STATE=/REENUM=/BOOT= for robust
  // parsing. BOOT (boot_id) lets the monitor detect a mid-window reboot, which resets
  // the journal the re-enum count derives from and would otherwise fake a `latched`.
  const remote = [
    'U=$(ls -1 /sys/class/udc 2>/dev/null | head -n1)',
    'printf "STATE=%s\\n" "$(cat /sys/class/udc/$U/state 2>/dev/null)"',
    `printf "REENUM=%s\\n" "$(${reenumCmd})"`,
    'printf "BOOT=%s\\n" "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"',
  ].join('; ');
  // BatchMode → fail fast (never hang on a prompt) so unreachable is a reportable
  // state, not a silent hang. StrictHostKeyChecking=yes → known_hosts already has
  // pikvm01; a host-key surprise fails fast rather than trusting blindly.
  const args = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutS}`,
    '-o', 'StrictHostKeyChecking=yes',
    host,
    remote,
  ];

  // Last successfully-read raw count, reused when a count read fails so a transient
  // dmesg hiccup neither suppresses the latch signal nor fakes a ring wrap.
  let lastRawReenum = 0;

  return {
    async read(): Promise<SourceReading> {
      let res: { code: number; stdout: string; stderr: string };
      try {
        res = await exec(sshBinary, args, { timeoutMs });
      } catch (e) {
        return { ok: false, error: `ssh exec threw: ${(e as Error).message}` };
      }
      if (res.code !== 0) {
        const detail = (res.stderr || res.stdout).trim().slice(0, 200) || 'unreachable';
        return { ok: false, error: `ssh rc=${res.code}: ${detail}` };
      }
      const state = /STATE=(.*)/.exec(res.stdout)?.[1]?.trim();
      if (state === undefined || state === '') {
        return { ok: false, error: `unparseable UDC state in remote output: ${res.stdout.trim().slice(0, 200)}` };
      }
      const reenumStr = /REENUM=(\d+)/.exec(res.stdout)?.[1];
      if (reenumStr !== undefined) lastRawReenum = Number(reenumStr);
      // else: keep lastRawReenum — a count-read miss must not drop the latch signal.
      const bootId = /BOOT=([0-9a-fA-F-]+)/.exec(res.stdout)?.[1];
      // The source owns the health verdict; the classifier just consumes the boolean.
      return { ok: true, healthy: state === healthyState, rawReenum: lastRawReenum, bootId, detail: state, state };
    },
  };
}
