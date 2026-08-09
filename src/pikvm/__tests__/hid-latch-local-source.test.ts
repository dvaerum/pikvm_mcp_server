import { describe, it, expect } from 'vitest';
import { makeLocalLatchSource, type LocalLatchDeps } from '../hid-latch-local-source.js';

const UDC = 'fe980000.usb';
const F = `/sys/class/udc/${UDC}/function`;
const S = `/sys/class/udc/${UDC}/state`;
const BOOT = '/proc/sys/kernel/random/boot_id';
const CONFIGFS = '/sys/kernel/config/usb_gadget/kvmd/UDC';
const BOOT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Injectable local reads. A file mapped to an Error (or absent) REJECTS (ENOENT-like). */
function fakeDeps(
  files: Record<string, string | Error>,
  reenum: number | (() => number | Promise<number>) = 0,
  udcEntries: string[] | Error = [UDC],
): LocalLatchDeps {
  return {
    readFile: async (p) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      const v = files[p];
      if (v instanceof Error) throw v;
      return v;
    },
    listDir: async () => {
      if (udcEntries instanceof Error) throw udcEntries;
      return udcEntries;
    },
    reenumCount: async () => (typeof reenum === 'function' ? reenum() : reenum),
  };
}

/** A bound, healthy box: function non-empty, state configured, gadget dir present. */
const boundConfigured = (reenum = 0) =>
  fakeDeps({ [F]: 'configfs-gadget.kvmd\n', [S]: 'configured\n', [BOOT]: `${BOOT_ID}\n`, [CONFIGFS]: `${UDC}\n` }, reenum);

describe('makeLocalLatchSource — composite health (bound AND state-acceptable)', () => {
  it('bound + configured ⇒ healthy, with structured passthrough', async () => {
    const r = await makeLocalLatchSource({ deps: boundConfigured(3) }).read();
    expect(r).toEqual({ ok: true, healthy: true, bound: true, state: 'configured', detail: 'configured', rawReenum: 3, bootId: BOOT_ID });
  });

  it('bound + `not attached` is HEALTHY (uncabled-but-bound; bound-ness is the gate)', async () => {
    const deps = fakeDeps({ [F]: 'configfs-gadget.kvmd', [S]: 'not attached', [BOOT]: BOOT_ID, [CONFIGFS]: UDC });
    const r = await makeLocalLatchSource({ deps }).read();
    expect(r).toMatchObject({ ok: true, healthy: true, bound: true, state: 'not attached', detail: 'not attached (bound)' });
  });

  it('bound but a non-acceptable state (stuck `addressed`) ⇒ unhealthy', async () => {
    const deps = fakeDeps({ [F]: 'configfs-gadget.kvmd', [S]: 'addressed', [BOOT]: BOOT_ID, [CONFIGFS]: UDC });
    const r = await makeLocalLatchSource({ deps }).read();
    expect(r).toMatchObject({ ok: true, healthy: false, bound: true, state: 'addressed' });
  });

  it('a custom acceptable-state set narrows what counts as healthy', async () => {
    const deps = fakeDeps({ [F]: 'g', [S]: 'not attached', [BOOT]: BOOT_ID, [CONFIGFS]: UDC });
    const r = await makeLocalLatchSource({ deps, acceptableStates: ['configured'] }).read();
    expect(r).toMatchObject({ ok: true, healthy: false }); // not attached no longer acceptable
  });
});

describe('makeLocalLatchSource — the #48 trap: unbound must be BROKEN, never a source_error', () => {
  it('function EMPTY (unbound) + gadget dir present ⇒ healthy:false, `unbound (gadget torn down)`', async () => {
    const deps = fakeDeps({ [F]: '', [S]: 'not attached', [BOOT]: BOOT_ID, [CONFIGFS]: UDC });
    const r = await makeLocalLatchSource({ deps }).read();
    expect(r).toMatchObject({ ok: true, healthy: false, bound: false, detail: 'unbound (gadget torn down)' });
  });

  it('⭐ #48: function EMPTY + configfs ENOENT ⇒ healthy:false (BROKEN), NOT source_error', async () => {
    // The most-dead box (kvmd-otg never created the gadget dir). Keying on
    // /sys/.../function (empty ⇒ unbound) catches it; reading configfs (ENOENT) must
    // NOT throw a source_error — that would report the most-dead box as unreachable.
    const deps = fakeDeps({ [F]: '', [S]: 'not attached', [BOOT]: BOOT_ID }); // CONFIGFS absent
    const r = await makeLocalLatchSource({ deps }).read();
    expect(r.ok).toBe(true); // ← the trap: NOT a source_error
    expect(r).toMatchObject({ healthy: false, bound: false, detail: 'unbound (#48: no gadget dir)' });
  });
});

describe('makeLocalLatchSource — a GENUINE source_error is only /sys itself unreadable', () => {
  it('reading the UDC `function` throwing (sysfs read fault) ⇒ ok:false', async () => {
    const deps = fakeDeps({ [F]: Object.assign(new Error('EIO'), { code: 'EIO' }), [S]: 'x', [BOOT]: BOOT_ID });
    const r = await makeLocalLatchSource({ deps }).read();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/read failed/);
  });

  it('`/sys/class/udc` unlistable ⇒ ok:false (no UDC to read)', async () => {
    const deps = fakeDeps({}, 0, new Error('ENOENT /sys/class/udc'));
    const r = await makeLocalLatchSource({ deps }).read();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/\/sys\/class\/udc/);
  });
});

describe('makeLocalLatchSource — reenum (boot-scoped; pattern-config; lenient)', () => {
  it('the reenum count flows through as rawReenum', async () => {
    const r = await makeLocalLatchSource({ deps: boundConfigured(12) }).read();
    expect(r).toMatchObject({ ok: true, rawReenum: 12 });
  });

  it('a reenum read failure reuses the last value — never drops the latch signal', async () => {
    let call = 0;
    const deps = fakeDeps(
      { [F]: 'g', [S]: 'not attached', [BOOT]: BOOT_ID, [CONFIGFS]: UDC },
      () => {
        call += 1;
        if (call === 2) throw new Error('journalctl transient');
        return 7;
      },
    );
    const src = makeLocalLatchSource({ deps });
    const r1 = await src.read(); // reenum → 7
    const r2 = await src.read(); // reenum throws → reuse 7 (not dropped to 0)
    expect(r1).toMatchObject({ ok: true, rawReenum: 7 });
    expect(r2).toMatchObject({ ok: true, rawReenum: 7 });
  });
});
