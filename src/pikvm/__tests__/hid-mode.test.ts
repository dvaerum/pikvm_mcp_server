import { describe, it, expect } from 'vitest';
import {
  HidModeResolver,
  makeHttpHidModeEndpoint,
  modeIsAbsolute,
  type HidMode,
  type HidModeEndpoint,
  type HidModeReading,
} from '../hid-mode.js';

/** In-memory endpoint: programmable read result + call counters, injectable clock.
 *  `mode` = the OBSERVED gadget; `requested` defaults to `mode` (no drift) unless set. */
function fakeEndpoint(init?: {
  mode?: HidMode | null;
  reachable?: boolean;
}): HidModeEndpoint & {
  reads: number;
  writes: HidMode[];
  set(mode: HidMode | null, reachable?: boolean): void;
  setDrift(observed: HidMode, requested: HidMode): void;
  writeResult: { ok: boolean; message: string };
} {
  let mode: HidMode | null = init?.mode ?? 'ipad';
  let requested: HidMode | null = init?.mode ?? 'ipad';
  let settled = true;
  let reachable = init?.reachable ?? true;
  const state = {
    configured: true,
    reads: 0,
    writes: [] as HidMode[],
    writeResult: { ok: true, message: 'mode switching, wait ~8s; USB re-enumerates, session drops' },
    set(m: HidMode | null, r = true) { mode = m; requested = m; settled = true; reachable = r; },
    /** next-boot pending: the gadget stays `observed` while the yaml requests a different mode. */
    setDrift(observed: HidMode, req: HidMode) { mode = observed; requested = req; settled = true; reachable = true; },
    async read(): Promise<HidModeReading | null> {
      state.reads++;
      return reachable ? { mode, requested, settled } : null;
    },
    async write(m: HidMode): Promise<{ ok: boolean; message: string }> {
      state.writes.push(m);
      return state.writeResult;
    },
  };
  return state;
}

describe('hid-mode helpers', () => {
  it('maps desktop→absolute, ipad→relative', () => {
    expect(modeIsAbsolute('desktop')).toBe(true);
    expect(modeIsAbsolute('ipad')).toBe(false);
  });
});

describe('makeHttpHidModeEndpoint — consumes the FULL PIKVM_HIDMODE_URL (module-author contract)', () => {
  it('GET/POST target the URL AS-IS (no /hidmode appended) with a bearer token, and parse the contract shapes', async () => {
    const seen: { get: string[]; post: Array<{ u: string; b: string; auth?: string }> } = { get: [], post: [] };
    const ep = makeHttpHidModeEndpoint(
      { url: 'http://127.0.0.1:8083/hidmode', token: 'tok' },
      {
        get: async (u, h) => { seen.get.push(u); expect(h.authorization).toBe('Bearer tok'); return { status: 200, body: { ok: true, mode: 'ipad', requested: 'ipad', settled: true } }; },
        post: async (u, h, b) => { seen.post.push({ u, b, auth: h.authorization }); return { status: 200, body: { ok: true, mode: 'desktop', message: 'mode switching to desktop; USB re-enumerates and the active session drops (~5s)' } }; },
      },
    );
    expect(ep.configured).toBe(true);
    expect(await ep.read()).toEqual({ mode: 'ipad', requested: 'ipad', settled: true }); // mode=observed, ignores `ok`
    expect(seen.get[0]).toBe('http://127.0.0.1:8083/hidmode'); // AS-IS — NOT .../hidmode/hidmode
    const w = await ep.write('desktop');
    expect(seen.post[0].u).toBe('http://127.0.0.1:8083/hidmode');
    expect(JSON.parse(seen.post[0].b)).toEqual({ mode: 'desktop' });
    expect(seen.post[0].auth).toBe('Bearer tok');
    expect(w.ok).toBe(true);
    expect(w.message).toMatch(/switching/);
  });

  it('non-200 GET (e.g. 401 unauthorized) → null (unknown ⇒ fail-closed upstream)', async () => {
    const ep = makeHttpHidModeEndpoint({ url: 'http://x/hidmode' }, { get: async () => ({ status: 401, body: { ok: false, message: 'unauthorized' } }) });
    expect(await ep.read()).toBeNull();
  });

  it('a POST error status (502 trigger failure) → ok:false carrying the endpoint message', async () => {
    const ep = makeHttpHidModeEndpoint({ url: 'http://x/hidmode' }, { post: async () => ({ status: 502, body: { ok: false, message: 'switch to ipad failed (rc=1)' } }) });
    const w = await ep.write('ipad');
    expect(w.ok).toBe(false);
    expect(w.message).toMatch(/failed/);
  });

  it('an unconfigured endpoint (no URL) reads null and reports not configured', async () => {
    const ep = makeHttpHidModeEndpoint({});
    expect(ep.configured).toBe(false);
    expect(await ep.read()).toBeNull();
  });
});

describe('HidModeResolver — declared (pikvm01 / no endpoint)', () => {
  it('returns the fixed mode, always reachable, never settling, never re-reads', async () => {
    const l = new HidModeResolver({ declared: 'ipad' });
    expect(await l.resolve()).toBe('ipad');
    const s = l.status();
    expect(s).toMatchObject({ mode: 'ipad', source: 'declared', reachable: true, settling: false });
    expect(l.moverGate().allowed).toBe(true);
  });
  it('a declared resolver cannot be switched (no endpoint to POST)', async () => {
    const l = new HidModeResolver({ declared: 'desktop' });
    const r = await l.set('ipad');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no.*endpoint|declared|fixed/i);
  });
});

describe('HidModeResolver — endpoint (appliance)', () => {
  it('derives the mode from the endpoint; mouseAbsolute follows', async () => {
    const ep = fakeEndpoint({ mode: 'desktop' });
    const l = new HidModeResolver({ endpoint: ep });
    expect(await l.resolve()).toBe('desktop');
    expect(modeIsAbsolute((await l.resolve())!)).toBe(true);
    expect(l.status().source).toBe('endpoint');
  });

  it('FAIL-CLOSED: unreachable ⇒ mode unknown (null) and mover ops REFUSE with a clear reason', async () => {
    const ep = fakeEndpoint({ reachable: false });
    const l = new HidModeResolver({ endpoint: ep });
    expect(await l.resolve()).toBeNull();
    const gate = l.moverGate();
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/unknown|unreachable/i);
    expect(l.status().reachable).toBe(false);
  });

  it('recovers: once the endpoint answers again, the mode resolves and the mover unblocks', async () => {
    const ep = fakeEndpoint({ reachable: false });
    const l = new HidModeResolver({ endpoint: ep });
    expect(await l.resolve()).toBeNull();
    ep.set('ipad', true);
    expect(await l.resolve()).toBe('ipad'); // no TTL wait — failures are never cached
    expect(l.moverGate().allowed).toBe(true);
  });

  it('short-TTL cache: a fresh read is reused; the endpoint is not hit per-call', async () => {
    let t = 1000;
    const ep = fakeEndpoint({ mode: 'ipad' });
    const l = new HidModeResolver({ endpoint: ep, ttlMs: 5000, now: () => t });
    await l.resolve();
    await l.resolve();
    await l.resolve();
    expect(ep.reads).toBe(1); // cached within TTL
    t += 5001;
    await l.resolve();
    expect(ep.reads).toBe(2); // re-read after TTL
  });

  it('markReconnect forces a re-read even within the TTL (a switch drops the session)', async () => {
    let t = 1000;
    const ep = fakeEndpoint({ mode: 'ipad' });
    const l = new HidModeResolver({ endpoint: ep, ttlMs: 5000, now: () => t });
    await l.resolve();
    expect(ep.reads).toBe(1);
    l.markReconnect();
    await l.resolve();
    expect(ep.reads).toBe(2);
  });

  it('SETTLING: a mode change detected on re-read blocks the mover until the HID is confirmed online', async () => {
    let t = 1000;
    const ep = fakeEndpoint({ mode: 'ipad' });
    const l = new HidModeResolver({ endpoint: ep, ttlMs: 1, now: () => t });
    await l.resolve();
    expect(l.moverGate().allowed).toBe(true);
    ep.set('desktop'); // switched by another surface (web UI / kvmd API)
    t += 10;
    await l.resolve(); // detects the change
    expect(l.status().settling).toBe(true);
    expect(l.moverGate().allowed).toBe(false);
    expect(l.moverGate().reason).toMatch(/re-enumerat|settl|online/i);
    l.clearSettling(); // integration confirms HID online (UDC ground truth)
    expect(l.moverGate().allowed).toBe(true);
  });

  it('LATCH REGRESSION (#51): settling AUTO-EXPIRES after the window with NO clearSettling — the mover cannot dead-latch across a healthy box', async () => {
    // The #51 bug: settling was a one-way flag cleared ONLY by pikvm_health_check's
    // clearSettling(); polling pikvm_hidmode_status (which never clears) left the mover
    // gated until an MCP restart. Here health_check NEVER runs — the gate must self-heal
    // from the clock once the bounded re-enum window elapses.
    let t = 1000;
    const ep = fakeEndpoint({ mode: 'ipad' });
    const l = new HidModeResolver({ endpoint: ep, ttlMs: 1, settleWindowMs: 15000, now: () => t });
    await l.resolve();
    ep.set('desktop'); // switched by another surface
    t += 10;
    await l.resolve(); // detects the change → settling
    expect(l.status().settling).toBe(true);
    expect(l.moverGate().allowed).toBe(false); // correctly gated DURING the re-enum window
    // ...no clearSettling(), no restart — just the clock advancing past the window.
    t += 15000;
    expect(l.status().settling).toBe(false);   // re-derived from now(): window elapsed ⇒ open
    expect(l.moverGate().allowed).toBe(true);  // self-healed — the latch is impossible
  });

  it('settling stays closed for the FULL window when clearSettling never runs (no premature open)', async () => {
    let t = 1000;
    const ep = fakeEndpoint({ mode: 'ipad' });
    const l = new HidModeResolver({ endpoint: ep, ttlMs: 1, settleWindowMs: 15000, now: () => t });
    await l.resolve();
    ep.set('desktop');
    t += 10;         // t=1010: the resolve below anchors the window ⇒ settleUntil=1010+15000=16010
    await l.resolve();
    expect(l.moverGate().allowed).toBe(false);
    t += 14999;      // t=16009: still inside the window (< 16010)
    expect(l.moverGate().allowed).toBe(false);
    t += 2;          // t=16011: past the window ⇒ gate re-opens
    expect(l.moverGate().allowed).toBe(true);
  });

  it('the FIRST read does not settle (no prior mode to differ from)', async () => {
    const ep = fakeEndpoint({ mode: 'desktop' });
    const l = new HidModeResolver({ endpoint: ep });
    await l.resolve();
    expect(l.status().settling).toBe(false);
    expect(l.moverGate().allowed).toBe(true);
  });

  it('set() POSTs the new mode, begins settling, and returns an HONEST not-yet-live message', async () => {
    const ep = fakeEndpoint({ mode: 'ipad' });
    const l = new HidModeResolver({ endpoint: ep });
    await l.resolve();
    const r = await l.set('desktop');
    expect(ep.writes).toEqual(['desktop']);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/not.*live|session.*drop|re-?enumerat|reconnect/i);
    expect(l.status().settling).toBe(true);       // held until confirmed online
    expect(l.moverGate().allowed).toBe(false);
  });

  it('drives the OBSERVED gadget, not the request: a DRIFT (settled, requested≠observed) is NOT wrong-mode', async () => {
    // it-03400 contract: settled = "gadget recognisable", NOT "switch succeeded".
    // requested (the next-boot mode, from the yaml) is ipad but the gadget is still
    // desktop ⇒ mode=observed=desktop; the switch applies on the next reboot.
    const ep = fakeEndpoint({ mode: 'desktop' });
    const l = new HidModeResolver({ endpoint: ep });
    await l.resolve();
    ep.setDrift('desktop', 'ipad'); // next-boot pending: gadget desktop, requested ipad
    l.markReconnect();
    expect(await l.resolve()).toBe('desktop'); // we drive the ACTUAL gadget — correct, not confidently-wrong
    expect(l.moverGate().allowed).toBe(true);  // desktop IS a valid assembled mode
  });

  it('surfaces the DRIFT DIAGNOSTIC in status: settled + requested≠observed ⇒ a visible NEXT-BOOT-PENDING warning (#53)', async () => {
    const ep = fakeEndpoint({ mode: 'desktop' });
    const l = new HidModeResolver({ endpoint: ep });
    await l.resolve();
    expect(l.status().driftDetected).toBe(false); // requested==observed
    ep.setDrift('desktop', 'ipad');
    l.markReconnect();
    await l.resolve();
    const s = l.status();
    expect(s.driftDetected).toBe(true);
    expect(s.requestedMode).toBe('ipad');
    expect(s.mode).toBe('desktop'); // still driving the real gadget
    // wording matches #44's appliance warning ("will boot into X on next reboot").
    expect(s.warnings.join(' ')).toMatch(/next-boot pending|takes effect on the next reboot|will boot into/i);
  });

  it('UNSETTLED (mode=null while recognisable-pending) fail-closes with a re-assembly reason, not "unreachable"', async () => {
    const ep = fakeEndpoint({ mode: 'ipad' });
    const l = new HidModeResolver({ endpoint: ep });
    await l.resolve();
    ep.set(null, true); // reachable, but the gadget is mid-reassembly (mode=null)
    l.markReconnect();
    expect(await l.resolve()).toBeNull();
    expect(l.status().reachable).toBe(true);       // the endpoint answered
    expect(l.moverGate().allowed).toBe(false);
    expect(l.moverGate().reason).toMatch(/reassembl|unsettled|settle/i);
  });
});
