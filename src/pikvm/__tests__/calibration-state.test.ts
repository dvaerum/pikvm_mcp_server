/**
 * Tests for PiKVMClient's in-memory calibration state machine —
 * setCalibrationFactors / getCalibration / clearCalibration.
 *
 * The calibration state is mutated by these methods directly without
 * any network round-trip, so the entire state-machine contract can be
 * pinned without mocking fetch. Pinning matters: the [0.5, 2.0] sanity
 * range protects users from typos that would push the cursor wildly
 * off-screen, and setCalibrationFactors snapshots the *current cached
 * resolution* into the calibration record (so a later resolution
 * change can invalidate it).
 */

import { describe, expect, it } from 'vitest';
import { PiKVMClient } from '../client.js';

function makeClient(): PiKVMClient {
  return new PiKVMClient({
    host: 'https://example.invalid',
    username: 'admin',
    password: 'admin',
    verifySsl: false,
  });
}

describe('PiKVMClient calibration state machine', () => {
  it('starts uncalibrated', () => {
    const client = makeClient();
    expect(client.getCalibration()).toBeNull();
  });

  it('setCalibrationFactors records factors for retrieval', () => {
    const client = makeClient();
    client.setCalibrationFactors(1.1, 1.2);
    const cal = client.getCalibration();
    expect(cal).not.toBeNull();
    expect(cal!.factorX).toBe(1.1);
    expect(cal!.factorY).toBe(1.2);
  });

  it('clearCalibration returns the client to uncalibrated', () => {
    const client = makeClient();
    client.setCalibrationFactors(1.0, 1.0);
    client.clearCalibration();
    expect(client.getCalibration()).toBeNull();
  });

  it('rejects factorX below the 0.5 lower bound', () => {
    const client = makeClient();
    expect(() => client.setCalibrationFactors(0.4, 1.0)).toThrow(/range/i);
  });

  it('rejects factorX above the 2.0 upper bound', () => {
    const client = makeClient();
    expect(() => client.setCalibrationFactors(2.1, 1.0)).toThrow(/range/i);
  });

  it('rejects factorY below the 0.5 lower bound', () => {
    const client = makeClient();
    expect(() => client.setCalibrationFactors(1.0, 0.4)).toThrow(/range/i);
  });

  it('rejects factorY above the 2.0 upper bound', () => {
    const client = makeClient();
    expect(() => client.setCalibrationFactors(1.0, 2.1)).toThrow(/range/i);
  });

  it('accepts the 0.5 boundary value (inclusive lower bound)', () => {
    const client = makeClient();
    expect(() => client.setCalibrationFactors(0.5, 0.5)).not.toThrow();
    expect(client.getCalibration()!.factorX).toBe(0.5);
  });

  it('accepts the 2.0 boundary value (inclusive upper bound)', () => {
    const client = makeClient();
    expect(() => client.setCalibrationFactors(2.0, 2.0)).not.toThrow();
    expect(client.getCalibration()!.factorY).toBe(2.0);
  });

  it('error message names the offending factor values for operator diagnosis', () => {
    const client = makeClient();
    expect(() => client.setCalibrationFactors(3.0, 0.1)).toThrow(/3|0\.1/);
  });

  it('rejected calibration leaves prior state untouched', () => {
    const client = makeClient();
    client.setCalibrationFactors(1.1, 1.1);
    expect(() => client.setCalibrationFactors(99, 99)).toThrow();
    const cal = client.getCalibration();
    expect(cal!.factorX).toBe(1.1);
    expect(cal!.factorY).toBe(1.1);
  });

  it('snapshots a resolution placeholder when none has been cached yet', () => {
    const client = makeClient();
    client.setCalibrationFactors(1.0, 1.0);
    // No screenshot/getResolution has run yet, so cachedResolution is null
    // and the calibration record carries the {0,0} sentinel. This is the
    // documented contract — hasResolutionChanged() will then fire on the
    // first real resolution read, invalidating the (placeholder) calibration
    // and forcing the user to recalibrate at the actual resolution.
    const cal = client.getCalibration();
    expect(cal!.resolution).toEqual({ width: 0, height: 0 });
  });

  it('close() is safe to call (idempotent no-op for REST-only client)', () => {
    const client = makeClient();
    expect(() => client.close()).not.toThrow();
    expect(() => client.close()).not.toThrow();
  });
});
