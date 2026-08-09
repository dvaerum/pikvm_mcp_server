import { describe, it, expect } from 'vitest';
import { makeSshLatchSource, DEFAULT_SSH_BINARY, type SshLatchExec } from '../hid-latch-ssh-source.js';

/** Fake exec that returns scripted results and records (bin, args) per call. */
function fakeExec(results: Array<{ code: number; stdout: string; stderr: string }>): SshLatchExec & {
  calls: Array<{ bin: string; args: string[] }>;
} {
  let i = 0;
  const calls: Array<{ bin: string; args: string[] }> = [];
  const fn: SshLatchExec = async (bin, args) => {
    calls.push({ bin, args });
    return results[Math.min(i++, results.length - 1)];
  };
  return Object.assign(fn, { calls });
}

const BOOT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const okOut = (state: string, reenum: number, boot: string = BOOT_ID) => ({
  code: 0,
  stdout: `STATE=${state}\nREENUM=${reenum}\nBOOT=${boot}\n`,
  stderr: '',
});

describe('makeSshLatchSource — SSH idiom + parsing', () => {
  it('uses BatchMode + ConnectTimeout, passes the host, and resolves the UDC + state on-host', async () => {
    const exec = fakeExec([okOut('configured', 42)]);
    const src = makeSshLatchSource({ host: 'root@pikvm01.bb.vcamp.dk', exec, connectTimeoutS: 5 });
    const r = await src.read();
    expect(r).toEqual({ ok: true, healthy: true, rawReenum: 42, bootId: BOOT_ID, detail: 'configured', state: 'configured' });
    // MUST spawn Apple's system ssh (absolute) — an in-process store-binary
    // connection resurfaces the macOS Local-Network block, invisible in this VM.
    expect(exec.calls[0].bin).toBe(DEFAULT_SSH_BINARY);
    expect(DEFAULT_SSH_BINARY).toBe('/usr/bin/ssh');
    const args = exec.calls[0].args;
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ConnectTimeout=5');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('root@pikvm01.bb.vcamp.dk');
    const remote = args[args.length - 1];
    expect(remote).toContain('/sys/class/udc'); // reads the sysfs latch file
    expect(remote).toContain('STATE=');
    expect(remote).toContain('REENUM=');
    expect(remote).toContain('BOOT='); // boot_id for mid-window reboot detection
    expect(remote).toContain('/proc/sys/kernel/random/boot_id');
  });

  it('honors a sshBinary override (runnable where /usr/bin/ssh is absent, e.g. NixOS) without weakening the default', async () => {
    const exec = fakeExec([okOut('configured', 1)]);
    const src = makeSshLatchSource({ host: 'h', exec, sshBinary: '/run/current-system/sw/bin/ssh' });
    await src.read();
    expect(exec.calls[0].bin).toBe('/run/current-system/sw/bin/ssh');
    // default is unchanged for the Mac.
    const exec2 = fakeExec([okOut('configured', 1)]);
    await makeSshLatchSource({ host: 'h', exec: exec2 }).read();
    expect(exec2.calls[0].bin).toBe('/usr/bin/ssh');
  });

  it('parses a multi-word down state (`not attached`) and the boot_id', async () => {
    const src = makeSshLatchSource({ host: 'h', exec: fakeExec([okOut('not attached', 7)]) });
    expect(await src.read()).toEqual({ ok: true, healthy: false, rawReenum: 7, bootId: BOOT_ID, detail: 'not attached', state: 'not attached' });
  });

  it('a non-zero ssh exit is a SOURCE ERROR carrying the stderr (unreachable ≠ UDC-down)', async () => {
    const exec = fakeExec([{ code: 255, stdout: '', stderr: 'ssh: connect to host h port 22: Operation timed out' }]);
    const r = await src(exec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/rc=255.*timed out/);
  });

  it('a missing/empty UDC state is a source error, not a silent up', async () => {
    const r = await src(fakeExec([{ code: 0, stdout: 'STATE=\nREENUM=3\n', stderr: '' }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unparseable UDC state/);
  });

  it('LENIENT count: a missing REENUM keeps the last known value and still returns the latch state', async () => {
    const exec = fakeExec([okOut('configured', 100), { code: 0, stdout: 'STATE=not attached\n', stderr: '' }]);
    const s = makeSshLatchSource({ host: 'h', exec });
    expect(await s.read()).toEqual({ ok: true, healthy: true, rawReenum: 100, bootId: BOOT_ID, detail: 'configured', state: 'configured' });
    // second read has no REENUM line → reuse 100, but DO surface the (down) latch state.
    expect(await s.read()).toEqual({ ok: true, healthy: false, rawReenum: 100, detail: 'not attached', state: 'not attached' });
  });
});

/** Small helper: one-shot source over a single scripted exec result. */
function src(exec: SshLatchExec) {
  return makeSshLatchSource({ host: 'h', exec }).read();
}
