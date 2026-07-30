import { describe, it, expect } from 'vitest';
import {
  classifyHid,
  describeHidDiagnosis,
  diagnoseHidFromClient,
  type CursorLocator,
  type HidDiagnosisClient,
} from '../hid-diagnosis.js';

describe('classifyHid — HID DOWN vs HID UP-but-cursor-not-localizable', () => {
  it('HID down (input path dead) regardless of cursor', () => {
    expect(classifyHid({ hidUp: false, cursor: null })).toEqual({ kind: 'hid-down' });
    // even if a stale cursor still happens to be on screen, a down input path is DOWN
    expect(classifyHid({ hidUp: false, cursor: { x: 10, y: 20 } })).toEqual({ kind: 'hid-down' });
  });

  it('HID up + cursor localizable ⇒ healthy', () => {
    expect(classifyHid({ hidUp: true, cursor: { x: 100, y: 200 } })).toEqual({
      kind: 'healthy',
      cursor: { x: 100, y: 200 },
    });
  });

  it('HID up but cursor NOT localizable ⇒ the distinct diagnosis (NOT hid-down)', () => {
    const d = classifyHid({ hidUp: true, cursor: null });
    expect(d).toEqual({ kind: 'up-no-cursor' });
    expect(d.kind).not.toBe('hid-down');
  });

  it('degrades gracefully to unknown when HID up/down cannot be determined', () => {
    expect(classifyHid({ hidUp: null, cursor: null })).toEqual({ kind: 'unknown' });
    expect(classifyHid({ hidUp: null, cursor: { x: 1, y: 2 } })).toEqual({ kind: 'unknown' });
  });
});

describe('describeHidDiagnosis — the operator-facing discriminator', () => {
  it('HID-down text points at usb_reconnect', () => {
    const t = describeHidDiagnosis({ kind: 'hid-down' });
    expect(t).toContain('HID DOWN');
    expect(t).toContain('pikvm_usb_reconnect');
  });

  it('up-no-cursor text says usb_reconnect will NOT help and to wake the cursor', () => {
    const t = describeHidDiagnosis({ kind: 'up-no-cursor' });
    expect(t).toContain('HID UP but cursor NOT LOCALIZABLE');
    expect(t).toContain('NOT'); // usb_reconnect will NOT help
    expect(t).toContain('pikvm_mouse_move');
    // must NOT misdirect to usb_reconnect as the fix
    expect(t).not.toMatch(/Fix: pikvm_usb_reconnect/);
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

  it('uses UDC ground truth when available (down ⇒ hid-down, no cursor probe needed)', async () => {
    const d = await diagnoseHidFromClient(
      shotClient(),
      async () => ({ udc: 'usb-udc', state: 'not attached', online: false }),
      locates({ x: 5, y: 5 }),
    );
    expect(d.kind).toBe('hid-down');
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

  it('no UDC endpoint ⇒ falls back to the keyboard probe (keyboardOnline flag)', async () => {
    const kbdOffline: HidDiagnosisClient = {
      screenshot: async () => ({ buffer: Buffer.from('frame') }),
      getHidProfile: async () => ({ mouseOnline: false, keyboardOnline: false, mouseAbsolute: false }),
    };
    const d = await diagnoseHidFromClient(kbdOffline, async () => null, locates(null));
    expect(d.kind).toBe('hid-down'); // keyboard probe says down

    const kbdOnlineNoCursor: HidDiagnosisClient = {
      screenshot: async () => ({ buffer: Buffer.from('frame') }),
      getHidProfile: async () => ({ mouseOnline: true, keyboardOnline: true, mouseAbsolute: false }),
    };
    const d2 = await diagnoseHidFromClient(kbdOnlineNoCursor, async () => null, locates(null));
    expect(d2.kind).toBe('up-no-cursor'); // keyboard up but cursor not localizable
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
