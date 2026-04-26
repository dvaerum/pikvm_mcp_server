/**
 * Tests for BusyLock — pins the contract that index.ts uses to
 * prevent concurrent long-running operations (calibration, ballistics)
 * from clobbering each other. The error message includes the current
 * holder so an operator can tell what's already running.
 */

import { describe, expect, it } from 'vitest';
import { BusyLock } from '../lock.js';

describe('BusyLock', () => {
  it('starts unlocked', () => {
    const lock = new BusyLock();
    expect(lock.isBusy).toBe(false);
    expect(lock.holder).toBeNull();
  });

  it('acquire marks the lock busy and records the holder', () => {
    const lock = new BusyLock();
    lock.acquire('auto-calibrate');
    expect(lock.isBusy).toBe(true);
    expect(lock.holder).toBe('auto-calibrate');
  });

  it('release returns the lock to its starting state', () => {
    const lock = new BusyLock();
    lock.acquire('measure-ballistics');
    lock.release();
    expect(lock.isBusy).toBe(false);
    expect(lock.holder).toBeNull();
  });

  it('throws when acquiring an already-held lock', () => {
    const lock = new BusyLock();
    lock.acquire('auto-calibrate');
    expect(() => lock.acquire('measure-ballistics')).toThrow(/already held/);
  });

  it('error message names the current holder so the operator can tell what is running', () => {
    const lock = new BusyLock();
    lock.acquire('auto-calibrate');
    expect(() => lock.acquire('other')).toThrow(/auto-calibrate/);
  });

  it('can be re-acquired after release (full lifecycle)', () => {
    const lock = new BusyLock();
    lock.acquire('first');
    lock.release();
    lock.acquire('second');
    expect(lock.holder).toBe('second');
    expect(lock.isBusy).toBe(true);
  });

  it('release is idempotent — releasing an already-free lock is a no-op (does not throw)', () => {
    const lock = new BusyLock();
    expect(() => lock.release()).not.toThrow();
    expect(lock.isBusy).toBe(false);
    expect(lock.holder).toBeNull();
  });

  it('two independent BusyLock instances do not share state', () => {
    const a = new BusyLock();
    const b = new BusyLock();
    a.acquire('A');
    expect(b.isBusy).toBe(false);
    expect(() => b.acquire('B')).not.toThrow();
    expect(b.holder).toBe('B');
  });
});
