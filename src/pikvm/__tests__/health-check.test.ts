import { describe, it, expect } from 'vitest';
import { runHealthCheck, type HealthCheckClient } from '../health-check.js';

type Overrides = Partial<{
  streamer: () => Promise<{ sourceOnline: boolean; resolution: { width: number; height: number } }>;
  hid: () => Promise<{ mouseOnline: boolean; mouseAbsolute: boolean; keyboardOnline: boolean }>;
  screenshot: () => Promise<{ buffer: Buffer }>;
}>;

// Screenshot throws by default so the bounds/brightness image path (which needs
// a real decodable frame) is skipped — these tests target the reconciliation
// logic, which is the behaviour that moved out of the dispatch switch.
function stubClient(o: Overrides = {}): HealthCheckClient {
  return {
    getStreamerStatus:
      o.streamer ?? (async () => ({ sourceOnline: true, resolution: { width: 1920, height: 1080 } })),
    getHidProfile:
      o.hid ?? (async () => ({ mouseOnline: true, mouseAbsolute: false, keyboardOnline: true })),
    screenshot: o.screenshot ?? (async () => { throw new Error('no frame'); }),
  } as unknown as HealthCheckClient;
}

describe('runHealthCheck', () => {
  it('reports version and the resolver-mode-derived slam-guard implication', async () => {
    const r = await runHealthCheck(stubClient(), { resolverMouseAbsolute: false });
    expect(r.lines[0]).toMatch(/Server version: v/);
    expect(r.lines.join('\n')).toMatch(/forbidSlamFallback in click_at\/move_to defaults to true/);
  });

  it('reports UNKNOWN and skips the forbidSlamFallback line when the resolver mode is null', async () => {
    const r = await runHealthCheck(stubClient(), { resolverMouseAbsolute: null });
    expect(r.lines.join('\n')).toMatch(/Resolver mouse mode: UNKNOWN/);
    expect(r.lines.join('\n')).not.toMatch(/forbidSlamFallback/);
  });

  it('surfaces an OFFLINE streamer source with the wake guidance', async () => {
    const r = await runHealthCheck(
      stubClient({ streamer: async () => ({ sourceOnline: false, resolution: { width: 0, height: 0 } }) }),
      { resolverMouseAbsolute: false },
    );
    expect(r.lines.join('\n')).toMatch(/Streamer source: OFFLINE/);
  });

  it('READ-ONLY: prints MISMATCH when the live HID profile disagrees with the resolver, but returns no writable state', async () => {
    const r = await runHealthCheck(
      stubClient({ hid: async () => ({ mouseOnline: true, mouseAbsolute: true, keyboardOnline: true }) }),
      { resolverMouseAbsolute: false },
    );
    expect(r).not.toHaveProperty('mouseAbsoluteMode'); // ADR-0002 Phase 1: nothing to write back
    expect(r.lines.join('\n')).toMatch(/MISMATCH/);
    expect(r.lines.join('\n')).toMatch(/report-only; nothing here writes back/);
  });

  it('prints no MISMATCH when the profile agrees with the resolver', async () => {
    const r = await runHealthCheck(
      stubClient({ hid: async () => ({ mouseOnline: true, mouseAbsolute: false, keyboardOnline: true }) }),
      { resolverMouseAbsolute: false },
    );
    expect(r.lines.join('\n')).not.toMatch(/MISMATCH/);
  });

  it('skips the MISMATCH check entirely when the resolver mode is null (nothing to compare against)', async () => {
    const r = await runHealthCheck(
      stubClient({ hid: async () => ({ mouseOnline: true, mouseAbsolute: true, keyboardOnline: true }) }),
      { resolverMouseAbsolute: null },
    );
    expect(r.lines.join('\n')).not.toMatch(/MISMATCH/);
  });

  it('degrades gracefully when a probe throws (partial report, no crash)', async () => {
    const r = await runHealthCheck(
      stubClient({ hid: async () => { throw new Error('boom'); } }),
      { resolverMouseAbsolute: true },
    );
    expect(r.lines.join('\n')).toMatch(/Live HID profile: FAILED to read \(boom\)/);
    expect(r.lines.join('\n')).toMatch(/Screenshot: FAILED \(no frame\)/);
    expect(r.lines.join('\n')).toMatch(/resolver's mode stands \(currently true\)/);
  });

  describe('M4 — ground-truth UDC state', () => {
    it('falls back gracefully (no hard fail) when the UDC-state endpoint is unavailable', async () => {
      const r = await runHealthCheck(stubClient(), { resolverMouseAbsolute: false, udcState: null });
      expect(r.lines.join('\n')).toMatch(/USB HID gadget: unavailable/);
      expect(r.lines.join('\n')).toMatch(/PIKVM_HID_RECOVERY_URL/);
    });

    it('shows the ground-truth line + UP verdict when configured, no FLAG-LIE when flags agree', async () => {
      const r = await runHealthCheck(stubClient(), {
        resolverMouseAbsolute: false,
        udcState: { udc: 'fe980000.usb', state: 'configured', online: true },
      });
      const out = r.lines.join('\n');
      expect(out).toMatch(/USB HID gadget \(ground truth\): configured \[fe980000\.usb\]/);
      expect(out).toMatch(/HID verdict: UP/);
      expect(out).not.toMatch(/FLAG-LIE/);
    });

    it('flags the DOWN lie: kvmd online but UDC not attached → run pikvm_usb_reconnect', async () => {
      // default stub: mouse=on, keyboard=on (flags say online)
      const r = await runHealthCheck(stubClient(), {
        resolverMouseAbsolute: false,
        udcState: { udc: 'fe980000.usb', state: 'not attached', online: false },
      });
      const out = r.lines.join('\n');
      expect(out).toMatch(/FLAG-LIE: kvmd says online but UDC not attached/);
      expect(out).toMatch(/HID verdict: DOWN \(UDC not attached\) → run pikvm_usb_reconnect/);
    });

    it('flags the UP lie: kvmd offline but UDC configured → confirm behaviorally', async () => {
      const r = await runHealthCheck(
        stubClient({ hid: async () => ({ mouseOnline: false, mouseAbsolute: false, keyboardOnline: false }) }),
        { resolverMouseAbsolute: false, udcState: { udc: 'fe980000.usb', state: 'configured', online: true } },
      );
      const out = r.lines.join('\n');
      expect(out).toMatch(/FLAG-LIE: kvmd says HID offline but UDC is configured/);
      expect(out).toMatch(/HID verdict: UP/);
    });

    it('drives a DOWN verdict off "absent" (no gadget bound)', async () => {
      const r = await runHealthCheck(stubClient(), {
        resolverMouseAbsolute: false,
        udcState: { udc: null, state: 'absent', online: false },
      });
      expect(r.lines.join('\n')).toMatch(/HID verdict: DOWN \(UDC absent\) → run pikvm_usb_reconnect/);
    });
  });

  describe('(d) — HID DOWN vs HID UP-but-cursor-not-localizable', () => {
    const withFrame = () => stubClient({ screenshot: async () => ({ buffer: Buffer.from('frame') }) });

    it('HID UP (UDC configured) + cursor localizable ⇒ healthy pointer line', async () => {
      const r = await runHealthCheck(withFrame(), {
        resolverMouseAbsolute: false,
        udcState: { udc: 'fe980000.usb', state: 'configured', online: true },
        locateCursor: async () => ({ x: 640, y: 360 }),
      });
      const out = r.lines.join('\n');
      expect(out).toMatch(/HID UP and cursor localizable at \(640,360\)/);
    });

    it('HID UP but cursor NOT LOCALIZABLE ⇒ the distinct diagnosis, and does NOT tell the operator to usb_reconnect', async () => {
      const r = await runHealthCheck(withFrame(), {
        resolverMouseAbsolute: false,
        udcState: { udc: 'fe980000.usb', state: 'configured', online: true },
        locateCursor: async () => null,
      });
      const out = r.lines.join('\n');
      expect(out).toMatch(/HID UP but cursor NOT LOCALIZABLE/);
      expect(out).toMatch(/pikvm_usb_reconnect will NOT help/);
      expect(out).toMatch(/pikvm_mouse_move/);
    });

    it('HID DOWN (UDC not attached) SKIPS the pointer probe but STILL prints the DOWN verdict', async () => {
      let located = false;
      const r = await runHealthCheck(withFrame(), {
        resolverMouseAbsolute: false,
        udcState: { udc: 'fe980000.usb', state: 'not attached', online: false },
        locateCursor: async () => { located = true; return { x: 1, y: 1 }; },
      });
      expect(located).toBe(false); // guard: hidUp===false ⇒ no ORT inference on a dead gadget
      const out = r.lines.join('\n');
      expect(out).not.toMatch(/cursor localizable/); // pointer was not probed
      // …but the verdict MUST still print — this is the whole reason (d) exists.
      expect(out).toMatch(/HID DOWN/);
      expect(out).toMatch(/pikvm_usb_reconnect/);
    });

    it('STOCK box (no UDC endpoint) + BOTH flags offline ⇒ NON-DIRECTIVE hedge, never a confident reconnect directive', async () => {
      // No UDC reader ⇒ the down signal is flags-only, which misreport DOWN on a
      // working HID — so the verdict must HEDGE (confirm behaviorally), never emit a
      // bare "run pikvm_usb_reconnect". A verdict still prints (the print-fix), it's
      // just the suspected/non-directive one.
      let located = false;
      const r = await runHealthCheck(
        stubClient({
          screenshot: async () => ({ buffer: Buffer.from('frame') }),
          hid: async () => ({ mouseOnline: false, mouseAbsolute: false, keyboardOnline: false }),
        }),
        {
          resolverMouseAbsolute: false,
          udcState: null,
          locateCursor: async () => { located = true; return { x: 1, y: 1 }; },
        },
      );
      expect(located).toBe(false);
      const out = r.lines.join('\n');
      expect(out).toMatch(/Possible HID-down|UNCONFIRMED/); // a verdict DID print
      expect(out).toMatch(/confirm behaviorally/i);
      // the crucial invariant: NO confident down directive on the flags-only path
      expect(out).not.toMatch(/Fix: run pikvm_usb_reconnect/);
      expect(out).not.toMatch(/HID DOWN \(UDC/);
    });

    it('REGRESSION (live 2026-07-30): stock box, mouse ONLINE + keyboard OFFLINE ⇒ must NOT say HID DOWN', async () => {
      // The production rig: no UDC endpoint, kvmd persistently reports keyboard=offline
      // while the mouse clicks 4/4. A keyboard-only fallback emitted a FALSE "HID DOWN
      // → reconnect" on a healthy box. mouse||keyboard fallback ⇒ hidUp true ⇒ pointer
      // is probed and the verdict is a pointer one, never HID DOWN.
      const r = await runHealthCheck(
        stubClient({
          screenshot: async () => ({ buffer: Buffer.from('frame') }),
          hid: async () => ({ mouseOnline: true, mouseAbsolute: false, keyboardOnline: false }),
        }),
        {
          resolverMouseAbsolute: false,
          udcState: null,
          locateCursor: async () => null, // pointer faded on this staged frame
        },
      );
      const out = r.lines.join('\n');
      expect(out).not.toMatch(/HID DOWN/);
      expect(out).not.toMatch(/Fix: run pikvm_usb_reconnect/); // directiveness
      expect(out).toMatch(/HID UP but cursor NOT LOCALIZABLE/);
    });

    it('REGRESSION (symmetric, manager-required): stock box, keyboard ONLINE + mouse OFFLINE ⇒ must NOT say HID DOWN', async () => {
      // Mirror of the case that bit us; mouse-alone fallback would false-DOWN this
      // idle-mouse/active-keyboard session. either-online keeps it UP → pointer verdict.
      const r = await runHealthCheck(
        stubClient({
          screenshot: async () => ({ buffer: Buffer.from('frame') }),
          hid: async () => ({ mouseOnline: false, mouseAbsolute: false, keyboardOnline: true }),
        }),
        { resolverMouseAbsolute: false, udcState: null, locateCursor: async () => ({ x: 5, y: 5 }) },
      );
      const out = r.lines.join('\n');
      expect(out).not.toMatch(/HID DOWN/);
      expect(out).not.toMatch(/Fix: run pikvm_usb_reconnect/);
      expect(out).toMatch(/HID UP and cursor localizable/);
    });

    it('DIRECTIVENESS: on the udc-unavailable path, NO flag shape prints the confident reconnect directive', async () => {
      const shapes = [
        { mouseOnline: false, keyboardOnline: false }, // both offline ⇒ suspected/hedge
        { mouseOnline: true, keyboardOnline: false }, // the case that bit us
        { mouseOnline: false, keyboardOnline: true }, // symmetric
      ];
      for (const s of shapes) {
        const r = await runHealthCheck(
          stubClient({
            screenshot: async () => ({ buffer: Buffer.from('frame') }),
            hid: async () => ({ ...s, mouseAbsolute: false }),
          }),
          { resolverMouseAbsolute: false, udcState: null, locateCursor: async () => null },
        );
        expect(r.lines.join('\n')).not.toMatch(/Fix: run pikvm_usb_reconnect/);
      }
    });

    it('CONFIDENT directive IS allowed from UDC kernel state (not-attached ⇒ HID DOWN + reconnect)', async () => {
      const r = await runHealthCheck(withFrame(), {
        resolverMouseAbsolute: false,
        udcState: { udc: 'fe980000.usb', state: 'not attached', online: false },
        locateCursor: async () => null,
      });
      const out = r.lines.join('\n');
      expect(out).toMatch(/HID DOWN \(UDC kernel state\)/);
      expect(out).toMatch(/run pikvm_usb_reconnect/);
    });
  });
});
