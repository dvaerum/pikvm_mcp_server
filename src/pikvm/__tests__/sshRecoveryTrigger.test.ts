/**
 * SSH host-recovery transport (2026-07-30) — the stock-PiKVM backend for the
 * RecoveryTrigger contract. The behaviours that matter are TRUTHFULNESS (a
 * recovery is only "ok" when the kernel says the UDC is `configured`) and TIGHT
 * SCOPE (fixed sysfs/configfs sequences, never a general remote shell).
 */
import { describe, it, expect, vi } from 'vitest';
import { makeSshRecoveryTrigger, makeSshUdcStateReader, type SshExec } from '../hid-recovery.js';

const okExec = (stdout: string): SshExec => vi.fn(async () => ({ code: 0, stdout, stderr: '' }));

describe('makeSshRecoveryTrigger', () => {
  it('is not configured without a host, and escalate says so instead of throwing', async () => {
    const t = makeSshRecoveryTrigger({});
    expect(t.configured).toBe(false);
    await expect(t.escalate('soft_connect')).resolves.toMatchObject({ ok: false });
  });

  it('reports ok ONLY when the UDC actually reads configured afterwards', async () => {
    const exec = okExec('udc=fe980000.usb before=not attached after=configured\n');
    const t = makeSshRecoveryTrigger({ host: 'root@pikvm01', exec });
    const r = await t.escalate('soft_connect');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('after=configured');
  });

  it('is TRUTHFUL: exit 0 but a still-detached UDC is NOT a recovery', async () => {
    const exec = okExec('udc=fe980000.usb before=not attached after=not attached\n');
    const t = makeSshRecoveryTrigger({ host: 'root@pikvm01', exec });
    const r = await t.escalate('soft_connect');
    expect(r.ok).toBe(false);                       // the fix-(c) lesson
    expect(r.message).toMatch(/did NOT come up/);
    expect(r.message).toContain('after=not attached');
  });

  it('reports a non-zero exit as a failure with the host stderr', async () => {
    const exec: SshExec = vi.fn(async () => ({ code: 3, stdout: '', stderr: 'no UDC under /sys/class/udc' }));
    const t = makeSshRecoveryTrigger({ host: 'root@pikvm01', exec });
    const r = await t.escalate('soft_connect');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/exit 3/);
    expect(r.message).toContain('no UDC');
  });

  it('refuses reboot over this transport (scoped to UDC actions)', async () => {
    const exec = okExec('');
    const t = makeSshRecoveryTrigger({ host: 'root@pikvm01', exec });
    const r = await t.escalate('reboot');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not supported/i);
    expect(exec).not.toHaveBeenCalled();            // nothing was run on the host
  });

  it('discovers the UDC instead of hardcoding it, and only touches soft_connect + state', async () => {
    const exec = okExec('udc=x after=configured');
    await makeSshRecoveryTrigger({ host: 'root@pikvm01', exec }).escalate('soft_connect');
    const remote: string = (exec as unknown as { mock: { calls: string[][][] } }).mock.calls[0][0].at(-1) as string;
    expect(remote).toContain('ls -1 /sys/class/udc');
    expect(remote).toContain('/soft_connect');
    expect(remote).toContain('/state');
    expect(remote).not.toMatch(/rm |reboot|shutdown|systemctl/);
  });

  it('udc-rebind uses the configfs UDC unbind/rebind, not kvmd-otg restart', async () => {
    const exec = okExec('udc=x after=configured');
    await makeSshRecoveryTrigger({ host: 'root@pikvm01', exec }).escalate('udc-rebind');
    const remote: string = (exec as unknown as { mock: { calls: string[][][] } }).mock.calls[0][0].at(-1) as string;
    expect(remote).toContain('usb_gadget');
    expect(remote).toContain('$G/UDC');
    expect(remote).not.toContain('systemctl');       // the FileExistsError trap
  });

  it('never hangs on an auth prompt (BatchMode) and passes the host through', async () => {
    const exec = okExec('after=configured');
    await makeSshRecoveryTrigger({ host: 'root@pikvm01', exec }).escalate('soft_connect');
    const args: string[] = (exec as unknown as { mock: { calls: string[][][] } }).mock.calls[0][0] as unknown as string[];
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('root@pikvm01');
  });

  it('udc-rebind carries ONE bounded retry-with-settle, not a retry loop', async () => {
    const exec = okExec('udc=x after=configured retry=no');
    await makeSshRecoveryTrigger({ host: 'root@pikvm01', exec }).escalate('udc-rebind');
    const remote: string = (exec as unknown as { mock: { calls: string[][][] } }).mock.calls[0][0].at(-1) as string;
    // retry is guarded on the state re-read, and there is exactly one extra bind
    expect(remote).toContain('[ "$A" = "configured" ] ||');
    expect(remote).toMatch(/retry=/);
    expect(remote).not.toMatch(/while|until|for /);          // no loop
    expect((remote.match(/echo \$U > \$G\/UDC/g) ?? []).length).toBe(2); // initial + one retry
  });

  it('still reports the TRUTHFUL failure when even the retry does not attach', async () => {
    const exec = okExec('udc=x before=not attached after=not attached retry=retried');
    const r = await makeSshRecoveryTrigger({ host: 'root@pikvm01', exec }).escalate('udc-rebind');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('retry=retried');            // the caller sees it tried
  });

  it('refuses to interpolate an unsafe UDC/gadget name', () => {
    expect(() => makeSshRecoveryTrigger({ host: 'h', udc: 'x; rm -rf /' })).toThrow(/unsafe udc/);
    expect(() => makeSshRecoveryTrigger({ host: 'h', gadget: '$(id)' })).toThrow(/unsafe gadget/);
  });
});

describe('makeSshUdcStateReader (stock-box kernel ground truth)', () => {
  it('is disabled (always null) without a host, so callers fall back cleanly', async () => {
    await expect(makeSshUdcStateReader({})()).resolves.toBeNull();
  });

  it('reports online ONLY for the kernel "configured" state', async () => {
    const cfg = await makeSshUdcStateReader({ host: 'h', exec: okExec('udc=fe980000.usb state=configured\n') })();
    expect(cfg).toEqual({ udc: 'fe980000.usb', state: 'configured', online: true });
    const det = await makeSshUdcStateReader({ host: 'h', exec: okExec('udc=fe980000.usb state=not attached\n') })();
    expect(det).toEqual({ udc: 'fe980000.usb', state: 'not attached', online: false });
  });

  it('is READ-ONLY — it must never write to sysfs', async () => {
    const exec = okExec('udc=x state=configured');
    await makeSshUdcStateReader({ host: 'h', exec })();
    const remote: string = (exec as unknown as { mock: { calls: string[][][] } }).mock.calls[0][0].at(-1) as string;
    expect(remote).toContain('cat /sys/class/udc/');
    // read-only = no redirection INTO sysfs/configfs and no toggle/bind writes
    // (a bare `2>/dev/null` stderr redirect is fine and must not trip this).
    expect(remote).not.toMatch(/>\s*\/sys/);
    expect(remote).not.toContain('soft_connect');
    expect(remote).not.toContain('usb_gadget');
  });

  it('returns null (never a guess) on a failed or unparseable read', async () => {
    const bad: SshExec = async () => ({ code: 255, stdout: '', stderr: 'ssh: connect timeout' });
    await expect(makeSshUdcStateReader({ host: 'h', exec: bad })()).resolves.toBeNull();
    await expect(makeSshUdcStateReader({ host: 'h', exec: okExec('garbage') })()).resolves.toBeNull();
  });

  it('reports the synthetic absent state when no UDC exists', async () => {
    const r = await makeSshUdcStateReader({ host: 'h', exec: okExec('udc= state=absent') })();
    expect(r).toEqual({ udc: null, state: 'absent', online: false });
  });

  it('refuses an unsafe udc override', () => {
    expect(() => makeSshUdcStateReader({ host: 'h', udc: '$(reboot)' })).toThrow(/unsafe udc/);
  });
});
