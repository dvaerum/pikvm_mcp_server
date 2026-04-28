/**
 * Phase 154 — regression tests for isLockScreenRecoveryError.
 *
 * Phase 71 (v0.5.42) added a clear error message when moveToPixel
 * fails on the lock screen. Phase 72 (v0.5.43) added an auto-
 * recovery path that detects the lock-screen error and re-tries
 * after pikvm_ipad_unlock. The detection regex matches either
 * "lock screen" or "pikvm_ipad_unlock". Both alternatives are
 * load-bearing — Phase 75 pinned the error MESSAGE format, but
 * the DETECTION regex is a separate concern: the message can stay
 * the same while a refactor narrows the regex (e.g. dropping the
 * tool-name fallback) and the recovery silently stops firing.
 */

import { describe, expect, it } from 'vitest';
import { isLockScreenRecoveryError } from '../click-verify.js';

describe('isLockScreenRecoveryError', () => {
  it('matches the Phase 71 error phrase "lock screen"', () => {
    expect(
      isLockScreenRecoveryError(
        'detect-then-move failed; iPad may be on lock screen — call pikvm_ipad_unlock first',
      ),
    ).toBe(true);
  });

  it('matches the tool-name fallback "pikvm_ipad_unlock"', () => {
    // Even if "lock screen" wording changes in a future error
    // message, the tool-name reference should still trigger recovery.
    expect(
      isLockScreenRecoveryError(
        'detect failed; try pikvm_ipad_unlock then retry',
      ),
    ).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isLockScreenRecoveryError('Lock Screen')).toBe(true);
    expect(isLockScreenRecoveryError('PIKVM_IPAD_UNLOCK')).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(
      isLockScreenRecoveryError('motion-diff failed — cursor not found'),
    ).toBe(false);
    expect(
      isLockScreenRecoveryError('screen too dim'),
    ).toBe(false);
    expect(
      isLockScreenRecoveryError('iPadOS rate-limiting input'),
    ).toBe(false);
  });

  it('does NOT match on lock-related but unrelated phrases', () => {
    // "lockfile", "lock contention" etc. shouldn't trigger
    // unlock-recovery — only "lock screen" specifically.
    expect(isLockScreenRecoveryError('lockfile in use')).toBe(false);
    expect(isLockScreenRecoveryError('lock contention on db')).toBe(false);
    expect(isLockScreenRecoveryError('locked')).toBe(false);
  });

  it('handles empty string defensively', () => {
    expect(isLockScreenRecoveryError('')).toBe(false);
  });

  it('REGRESSION: collapsing the OR to single-alternative regex must fail', () => {
    // If a refactor narrows the regex to ONLY match "lock screen"
    // (dropping the tool-name fallback), this assertion catches it
    // because the tool-name-only error would no longer trigger
    // recovery.
    expect(
      isLockScreenRecoveryError('Try pikvm_ipad_unlock to recover'),
    ).toBe(true);
    // Conversely, if a refactor narrows to only the tool-name,
    // a future Phase 71 message that retains "lock screen" but
    // omits the tool-name reference would no longer trigger.
    expect(
      isLockScreenRecoveryError('iPad appears to be on lock screen'),
    ).toBe(true);
  });
});
