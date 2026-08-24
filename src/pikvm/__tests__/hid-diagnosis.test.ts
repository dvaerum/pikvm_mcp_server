import { describe, it, expect } from 'vitest';
import {
  classifyHid,
  describeHidDiagnosis,
  diagnoseHidFromClient,
  resolveHidUp,
  type CursorLocator,
  type HidDiagnosisClient,
} from '../hid-diagnosis.js';

describe('resolveHidUp — OR-semantics, pure (Phase 2 extraction of the previously-duplicated logic)', () => {
  it('UDC present ⇒ authoritative, confirmed, ignores hidFlags entirely', () => {
    expect(resolveHidUp({
      udc: { udc: 'usb-udc', state: 'configured', online: true },
      hidFlags: { mouseOnline: false, keyboardOnline: false }, // flags disagree — UDC wins
    })).toEqual({ hidUp: true, udcConfirmed: true });

    expect(resolveHidUp({
      udc: { udc: 'usb-udc', state: 'not attached', online: false },
      hidFlags: { mouseOnline: true, keyboardOnline: true }, // flags disagree — UDC still wins
    })).toEqual({ hidUp: false, udcConfirmed: true });
  });

  it('no UDC, flags present ⇒ EITHER online counts (not AND), unconfirmed', () => {
    expect(resolveHidUp({ udc: null, hidFlags: { mouseOnline: true, keyboardOnline: false } }))
      .toEqual({ hidUp: true, udcConfirmed: false });
    expect(resolveHidUp({ udc: null, hidFlags: { mouseOnline: false, keyboardOnline: true } }))
      .toEqual({ hidUp: true, udcConfirmed: false });
    expect(resolveHidUp({ udc: null, hidFlags: { mouseOnline: false, keyboardOnline: false } }))
      .toEqual({ hidUp: false, udcConfirmed: false });
  });

  it('neither UDC nor flags available ⇒ unknown, never a false verdict', () => {
    expect(resolveHidUp({ udc: null, hidFlags: null })).toEqual({ hidUp: null, udcConfirmed: false });
  });
});

describe('classifyHid — provenance-aware DOWN (confident vs suspected)', () => {
  it('hidUp=false + UDC-confirmed ⇒ CONFIDENT hid-down, regardless of cursor', () => {
    expect(classifyHid({ hidUp: false, cursor: null, udcConfirmed: true })).toEqual({ kind: 'hid-down' });
    // a stale cursor still on screen doesn't change a kernel-confirmed dead input path
    expect(classifyHid({ hidUp: false, cursor: { x: 10, y: 20 }, udcConfirmed: true })).toEqual({ kind: 'hid-down' });
  });

  it('hidUp=false + NOT UDC-confirmed (flags only) ⇒ hid-down-SUSPECTED (never confident)', () => {
    expect(classifyHid({ hidUp: false, cursor: null, udcConfirmed: false })).toEqual({ kind: 'hid-down-suspected' });
    // omitting udcConfirmed defaults to unconfirmed — the safe, non-directive side
    expect(classifyHid({ hidUp: false, cursor: null })).toEqual({ kind: 'hid-down-suspected' });
  });

  it('HID up + cursor localizable ⇒ healthy', () => {
    expect(classifyHid({ hidUp: true, cursor: { x: 100, y: 200 } })).toEqual({
      kind: 'healthy',
      cursor: { x: 100, y: 200 },
    });
  });

  it('HID up but cursor NOT localizable ⇒ up-no-cursor (never any hid-down kind)', () => {
    const d = classifyHid({ hidUp: true, cursor: null });
    expect(d).toEqual({ kind: 'up-no-cursor' });
    expect(d.kind).not.toBe('hid-down');
    expect(d.kind).not.toBe('hid-down-suspected');
  });

  it('degrades gracefully to unknown when HID up/down cannot be determined', () => {
    expect(classifyHid({ hidUp: null, cursor: null })).toEqual({ kind: 'unknown' });
    expect(classifyHid({ hidUp: null, cursor: { x: 1, y: 2 } })).toEqual({ kind: 'unknown' });
  });
});

describe('describeHidDiagnosis — directiveness follows provenance', () => {
  it('CONFIDENT hid-down (UDC) issues the reconnect directive', () => {
    const t = describeHidDiagnosis({ kind: 'hid-down' });
    expect(t).toContain('HID DOWN');
    expect(t).toMatch(/run pikvm_usb_reconnect/); // directive is allowed — it's kernel-backed
  });

  it('SUSPECTED hid-down (flags) is NON-DIRECTIVE — hedges, no bare reconnect command', () => {
    const t = describeHidDiagnosis({ kind: 'hid-down-suspected' });
    expect(t).toMatch(/UNCONFIRMED|possible/i);
    expect(t).toContain('confirm behaviorally');
    expect(t).toMatch(/misreport/);
    // the crucial invariant: it must NOT emit the confident directive
    expect(t).not.toMatch(/Fix: run pikvm_usb_reconnect/);
    expect(t).not.toMatch(/HID DOWN \(UDC/);
    // and it must NOT say a bare confident "HID DOWN" verdict
    expect(t).not.toMatch(/HID DOWN\b/);
  });

  it('up-no-cursor says usb_reconnect will NOT help and to wake the cursor', () => {
    const t = describeHidDiagnosis({ kind: 'up-no-cursor' });
    expect(t).toContain('HID UP but cursor NOT LOCALIZABLE');
    expect(t).toContain('pikvm_mouse_move');
    expect(t).toMatch(/will NOT help/);
  });

  it('healthy text reports the localized cursor position', () => {
    const t = describeHidDiagnosis({ kind: 'healthy', cursor: { x: 42, y: 99 } });
    expect(t).toContain('42');
    expect(t).toContain('99');
    expect(t).toContain('localizable');
  });

  it('unknown text mentions configuring the UDC endpoint', () => {
    expect(describeHidDiagnosis({ kind: 'unknown' })).toContain('PIKVM_HID_RECOVERY_URL');
  });
});

describe('diagnoseHidFromClient — orchestration with graceful UDC fallback', () => {
  const shotClient = (): HidDiagnosisClient => ({
    screenshot: async () => ({ buffer: Buffer.from('frame') }),
    getHidProfile: async () => ({ mouseOnline: true, keyboardOnline: true, mouseAbsolute: false }),
  });
  const locates =
    (pt: { x: number; y: number } | null): CursorLocator =>
    async () =>
      pt;

  it('UDC ground truth down ⇒ CONFIDENT hid-down (kernel-backed, directive allowed)', async () => {
    const d = await diagnoseHidFromClient(
      shotClient(),
      async () => ({ udc: 'usb-udc', state: 'not attached', online: false }),
      locates({ x: 5, y: 5 }),
    );
    expect(d.kind).toBe('hid-down'); // udcConfirmed ⇒ confident
  });

  it('UDC up + cursor localizable ⇒ healthy', async () => {
    const d = await diagnoseHidFromClient(
      shotClient(),
      async () => ({ udc: 'usb-udc', state: 'configured', online: true }),
      locates({ x: 7, y: 8 }),
    );
    expect(d).toEqual({ kind: 'healthy', cursor: { x: 7, y: 8 } });
  });

  it('UDC up + cursor NOT localizable ⇒ up-no-cursor', async () => {
    const d = await diagnoseHidFromClient(
      shotClient(),
      async () => ({ udc: 'usb-udc', state: 'configured', online: true }),
      locates(null),
    );
    expect(d.kind).toBe('up-no-cursor');
  });

  it('no UDC endpoint ⇒ flags fallback: BOTH offline ⇒ hid-down-SUSPECTED (never confident)', async () => {
    const bothOffline: HidDiagnosisClient = {
      screenshot: async () => ({ buffer: Buffer.from('frame') }),
      getHidProfile: async () => ({ mouseOnline: false, keyboardOnline: false, mouseAbsolute: false }),
    };
    const d = await diagnoseHidFromClient(bothOffline, async () => null, locates(null));
    expect(d.kind).toBe('hid-down-suspected'); // flags-only ⇒ suspected, NOT confident hid-down

    const bothOnlineNoCursor: HidDiagnosisClient = {
      screenshot: async () => ({ buffer: Buffer.from('frame') }),
      getHidProfile: async () => ({ mouseOnline: true, keyboardOnline: true, mouseAbsolute: false }),
    };
    const d2 = await diagnoseHidFromClient(bothOnlineNoCursor, async () => null, locates(null));
    expect(d2.kind).toBe('up-no-cursor'); // HID up but cursor not localizable
  });

  it('REGRESSION (live 2026-07-30): no UDC + mouse ONLINE + keyboard OFFLINE ⇒ must NOT say hid-down', async () => {
    // The production rig: gadget configured, mouse clicking 4/4, yet kvmd reports
    // keyboard=offline persistently. keyboard-only fallback emitted a FALSE HID DOWN.
    const mouseOnlyOnline: HidDiagnosisClient = {
      screenshot: async () => ({ buffer: Buffer.from('frame') }),
      getHidProfile: async () => ({ mouseOnline: true, keyboardOnline: false, mouseAbsolute: false }),
    };
    const localizable = await diagnoseHidFromClient(mouseOnlyOnline, async () => null, locates({ x: 3, y: 4 }));
    expect(localizable.kind).toBe('healthy'); // mouse online ⇒ up; cursor found ⇒ healthy
    expect(localizable.kind).not.toMatch(/^hid-down/);

    const faded = await diagnoseHidFromClient(mouseOnlyOnline, async () => null, locates(null));
    expect(faded.kind).toBe('up-no-cursor'); // up, but pointer faded — NOT down
    expect(faded.kind).not.toMatch(/^hid-down/);
  });

  it('REGRESSION (symmetric, manager-required): no UDC + keyboard ONLINE + mouse OFFLINE ⇒ must NOT say hid-down', async () => {
    // The mirror of the case that bit us — mouse-alone fallback would false-DOWN
    // this idle-mouse/active-keyboard session. either-online keeps it UP.
    const kbdOnlyOnline: HidDiagnosisClient = {
      screenshot: async () => ({ buffer: Buffer.from('frame') }),
      getHidProfile: async () => ({ mouseOnline: false, keyboardOnline: true, mouseAbsolute: false }),
    };
    const d = await diagnoseHidFromClient(kbdOnlyOnline, async () => null, locates({ x: 9, y: 9 }));
    expect(d.kind).toBe('healthy');
    expect(d.kind).not.toMatch(/^hid-down/);
  });

  it('does not throw the whole diagnosis when the keyboard probe itself fails', async () => {
    const brokenProfile: HidDiagnosisClient = {
      screenshot: async () => ({ buffer: Buffer.from('frame') }),
      getHidProfile: async () => {
        throw new Error('kvmd unreachable');
      },
    };
    const d = await diagnoseHidFromClient(brokenProfile, async () => null, locates({ x: 1, y: 1 }));
    expect(d.kind).toBe('unknown'); // can't prove up/down → unknown, not a crash
  });
});
