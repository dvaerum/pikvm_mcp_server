import { describe, it, expect } from 'vitest';
import { resolveHidModeSource } from '../cli.js';

/** #51: exactly one HID-mode source. Declared (--target) OR endpoint (PIKVM_HIDMODE_URL);
 *  BOTH = the two-copies defect (error), NEITHER = no source (error). See ADR 0002. */
describe('resolveHidModeSource', () => {
  it('declared: --target with no endpoint URL (stock pikvm01, regression-clean)', () => {
    expect(resolveHidModeSource('ipad', undefined)).toEqual({ kind: 'declared', target: 'ipad' });
    expect(resolveHidModeSource('desktop', undefined)).toEqual({ kind: 'declared', target: 'desktop' });
    expect(resolveHidModeSource('ipad', '')).toEqual({ kind: 'declared', target: 'ipad' }); // blank URL = unset
    expect(resolveHidModeSource('ipad', '   ')).toEqual({ kind: 'declared', target: 'ipad' });
  });

  it('endpoint: PIKVM_HIDMODE_URL with no --target (the appliance)', () => {
    expect(resolveHidModeSource(undefined, 'http://127.0.0.1:8080')).toEqual({ kind: 'endpoint' });
  });

  it('BOTH set → error (the two-copies defect, caught at config time)', () => {
    const r = resolveHidModeSource('ipad', 'http://127.0.0.1:8080');
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/mutually exclusive|single source of truth/i);
  });

  it('NEITHER set → error (no source)', () => {
    const r = resolveHidModeSource(undefined, undefined);
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/required|source/i);
  });
});
