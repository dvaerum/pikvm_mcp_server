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
  it('reports version and the mouseAbsoluteMode-derived slam-guard implication', async () => {
    const r = await runHealthCheck(stubClient(), { mouseAbsoluteMode: false });
    expect(r.lines[0]).toMatch(/Server version: v/);
    expect(r.lines.join('\n')).toMatch(/forbidSlamFallback in click_at\/move_to defaults to true/);
  });

  it('surfaces an OFFLINE streamer source with the wake guidance', async () => {
    const r = await runHealthCheck(
      stubClient({ streamer: async () => ({ sourceOnline: false, resolution: { width: 0, height: 0 } }) }),
      { mouseAbsoluteMode: false },
    );
    expect(r.lines.join('\n')).toMatch(/Streamer source: OFFLINE/);
  });

  it('refreshes mouseAbsoluteMode and prints MISMATCH when the live HID profile disagrees', async () => {
    const r = await runHealthCheck(
      stubClient({ hid: async () => ({ mouseOnline: true, mouseAbsolute: true, keyboardOnline: true }) }),
      { mouseAbsoluteMode: false },
    );
    expect(r.mouseAbsoluteMode).toBe(true); // reconciled to the live value
    expect(r.lines.join('\n')).toMatch(/MISMATCH/);
  });

  it('leaves mouseAbsoluteMode unchanged and prints no MISMATCH when the profile agrees', async () => {
    const r = await runHealthCheck(
      stubClient({ hid: async () => ({ mouseOnline: true, mouseAbsolute: false, keyboardOnline: true }) }),
      { mouseAbsoluteMode: false },
    );
    expect(r.mouseAbsoluteMode).toBe(false);
    expect(r.lines.join('\n')).not.toMatch(/MISMATCH/);
  });

  it('degrades gracefully when a probe throws (partial report, no crash)', async () => {
    const r = await runHealthCheck(
      stubClient({ hid: async () => { throw new Error('boom'); } }),
      { mouseAbsoluteMode: true },
    );
    expect(r.lines.join('\n')).toMatch(/Live HID profile: FAILED to read \(boom\)/);
    expect(r.lines.join('\n')).toMatch(/Screenshot: FAILED \(no frame\)/);
    expect(r.mouseAbsoluteMode).toBe(true); // unchanged on failure
  });

  describe('M4 — ground-truth UDC state', () => {
    it('falls back gracefully (no hard fail) when the UDC-state endpoint is unavailable', async () => {
      const r = await runHealthCheck(stubClient(), { mouseAbsoluteMode: false, udcState: null });
      expect(r.lines.join('\n')).toMatch(/USB HID gadget: unavailable/);
      expect(r.lines.join('\n')).toMatch(/PIKVM_HID_RECOVERY_URL/);
    });

    it('shows the ground-truth line + UP verdict when configured, no FLAG-LIE when flags agree', async () => {
      const r = await runHealthCheck(stubClient(), {
        mouseAbsoluteMode: false,
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
        mouseAbsoluteMode: false,
        udcState: { udc: 'fe980000.usb', state: 'not attached', online: false },
      });
      const out = r.lines.join('\n');
      expect(out).toMatch(/FLAG-LIE: kvmd says online but UDC not attached/);
      expect(out).toMatch(/HID verdict: DOWN \(UDC not attached\) → run pikvm_usb_reconnect/);
    });

    it('flags the UP lie: kvmd offline but UDC configured → confirm behaviorally', async () => {
      const r = await runHealthCheck(
        stubClient({ hid: async () => ({ mouseOnline: false, mouseAbsolute: false, keyboardOnline: false }) }),
        { mouseAbsoluteMode: false, udcState: { udc: 'fe980000.usb', state: 'configured', online: true } },
      );
      const out = r.lines.join('\n');
      expect(out).toMatch(/FLAG-LIE: kvmd says HID offline but UDC is configured/);
      expect(out).toMatch(/HID verdict: UP/);
    });

    it('drives a DOWN verdict off "absent" (no gadget bound)', async () => {
      const r = await runHealthCheck(stubClient(), {
        mouseAbsoluteMode: false,
        udcState: { udc: null, state: 'absent', online: false },
      });
      expect(r.lines.join('\n')).toMatch(/HID verdict: DOWN \(UDC absent\) → run pikvm_usb_reconnect/);
    });
  });
});
