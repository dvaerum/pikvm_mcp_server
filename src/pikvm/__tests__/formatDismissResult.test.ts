/**
 * Phase 172 — regression tests for formatDismissResult.
 *
 * The `pikvm_dismiss_popup` MCP handler's user-visible summary text
 * was inlined in src/index.ts. Phase 172 extracted as a pure
 * helper so both formatting branches (clean vs error-path) and the
 * load-bearing strings (pikvm_screenshot mention, key count
 * accuracy) are regression-pinned.
 */

import { describe, expect, it } from 'vitest';
import { formatDismissResult } from '../click-verify.js';

describe('formatDismissResult', () => {
  it('clean-path message includes the canonical Escape+Enter mention', () => {
    const msg = formatDismissResult({ keysSent: 2, errors: [] });
    expect(msg).toContain('Escape, Enter');
    expect(msg).toContain('sent 2 keys');
  });

  it('clean-path message tells the caller to verify with pikvm_screenshot', () => {
    // Load-bearing: agents reading this message need to know the
    // verification path. Removing this guidance would leave the
    // user wondering whether the recipe took effect.
    const msg = formatDismissResult({ keysSent: 2, errors: [] });
    expect(msg).toContain('pikvm_screenshot');
  });

  it('error-path message reports the error count', () => {
    const msg = formatDismissResult({
      keysSent: 1,
      errors: ['Escape: simulated'],
    });
    expect(msg).toContain('1 error');
    expect(msg).toContain('Escape: simulated');
  });

  it('error-path message reports keysSent accurately on partial success', () => {
    // If only Escape failed, Enter still went through — count must be 1.
    const msg = formatDismissResult({
      keysSent: 1,
      errors: ['Escape: simulated'],
    });
    expect(msg).toContain('sent 1 keys');
  });

  it('error-path message joins multiple errors with "; "', () => {
    const msg = formatDismissResult({
      keysSent: 0,
      errors: ['Escape: a', 'Enter: b'],
    });
    expect(msg).toContain('Escape: a; Enter: b');
  });

  it('error-path message indicates best-effort continuation', () => {
    // Phase 141's contract: dismiss is best-effort, never throws.
    // The user-facing message should communicate this so callers
    // know the operation didn't bail out at the first error.
    const msg = formatDismissResult({
      keysSent: 0,
      errors: ['Escape: a', 'Enter: b'],
    });
    expect(msg).toContain('Best-effort dismiss continued anyway');
  });

  it('REGRESSION: error-path branch is selected when errors array has any entries', () => {
    // If a refactor accidentally treats `errors.length` differently
    // (e.g. checks errors[0] instead), this would catch it.
    const cleanMsg = formatDismissResult({ keysSent: 2, errors: [] });
    const errorMsg = formatDismissResult({ keysSent: 2, errors: ['x: y'] });
    expect(cleanMsg).not.toContain('error');
    expect(errorMsg).toContain('error');
  });

  it('REGRESSION: keysSent === 0 with no errors is still clean-path (vacuous success)', () => {
    // Edge case: defensive — if for some reason both keys are
    // missing without error, the result message should still
    // route to the clean-path. Unlikely to fire in practice.
    const msg = formatDismissResult({ keysSent: 0, errors: [] });
    expect(msg).toContain('Escape, Enter');
    expect(msg).not.toContain('error');
  });
});
