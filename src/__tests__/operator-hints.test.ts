/**
 * Phase 190: pin the contract of `appendOperatorHint`.
 *
 * Each hint pattern has a positive case (matches → hint appended) and
 * a negative case (unrelated message → unchanged). The function is
 * pure so no fixtures / mocks are needed.
 */

import { describe, expect, it } from 'vitest';
import { appendOperatorHint } from '../operator-hints.js';

describe('appendOperatorHint', () => {
  describe('503 + UnavailableError → source-side outage hint', () => {
    it('matches the canonical PiKVM 503 body and appends the health-check hint', () => {
      const raw = 'PiKVM API error 503: { "ok": false, "result": { "error": "UnavailableError", "error_msg": "Service Unavailable" } }';
      const out = appendOperatorHint(raw);
      expect(out).toContain('PiKVM API error 503');
      expect(out).toContain('pikvm_health_check');
      expect(out).toContain('streamer.source.online');
      // Hint goes on a new line, separated from the raw error.
      expect(out.split('\n').length).toBeGreaterThan(1);
    });

    it('matches even when the 503 appears without the JSON body (just the numeric code + class)', () => {
      const raw = 'Some operation failed: HTTP 503 with class UnavailableError';
      const out = appendOperatorHint(raw);
      expect(out).toContain('pikvm_health_check');
    });
  });

  describe('Service Unavailable without explicit 503 → also gets the hint', () => {
    it('matches "Service Unavailable" alone', () => {
      const raw = 'Streamer error: Service Unavailable';
      const out = appendOperatorHint(raw);
      expect(out).toContain('pikvm_health_check');
    });
  });

  describe('Unrelated error messages pass through unchanged', () => {
    it('non-503 HTTP error → no hint', () => {
      const raw = 'PiKVM API error 401: Unauthorized';
      expect(appendOperatorHint(raw)).toBe(raw);
    });

    it('motion-diff failure message → no hint', () => {
      const raw = 'moveToPixel: detect-then-move failed (motion-diff and template-match both returned no cursor)';
      expect(appendOperatorHint(raw)).toBe(raw);
    });

    it('typecheck/build error → no hint', () => {
      const raw = 'TypeError: Cannot read property "foo" of undefined';
      expect(appendOperatorHint(raw)).toBe(raw);
    });

    it('empty string → unchanged', () => {
      expect(appendOperatorHint('')).toBe('');
    });
  });

  describe('Pattern ordering — more-specific match wins (only one hint added)', () => {
    it('a message containing both "503" and "Service Unavailable" gets ONE hint, not two', () => {
      const raw = 'PiKVM API error 503: UnavailableError - Service Unavailable';
      const out = appendOperatorHint(raw);
      // Count occurrences of "pikvm_health_check" — should be exactly one.
      const matches = out.match(/pikvm_health_check/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(1);
    });
  });
});
