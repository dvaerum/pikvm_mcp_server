import { describe, it, expect, afterEach } from 'vitest';
import { loadSettings, getSettings, resetSettingsForTest } from '../settings.js';

describe('loadSettings', () => {
  it('applies documented defaults on an empty env', () => {
    const s = loadSettings({});
    expect(s.ml.model).toBeUndefined();
    expect(s.ml.v5Model).toBeUndefined();
    expect(s.ml.v5PresenceGate).toBe(false);
    expect(s.ml.v8Model).toBeUndefined();
    expect(s.ml.cascadeEnabled).toBe(true); // DEFAULT ON
    expect(s.ml.verifierModel).toBeUndefined();
    expect(s.ml.gridStride).toBe(48);
    expect(s.ml.verifyThresh).toBe(0.5);
    expect(s.ml.captureDir).toBeUndefined();
    expect(s.ml.disabled).toBe(false);
    expect(s.movement.useLearnedBallistics).toBe(false);
    expect(s.movement.disableRetrySkipProbe).toBe(false);
    expect(s.movement.predownDir).toBeUndefined();
    expect(s.movement.forceWake).toBe(false);
    expect(s.movement.clickMaxResidualPxRaw).toBeUndefined();
    expect(s.pointerAccelModel).toBeUndefined();
    expect(s.emitLog).toBeUndefined();
  });

  it('cascade is disabled ONLY by the exact string "0"', () => {
    expect(loadSettings({ PIKVM_ML_CASCADE: '0' }).ml.cascadeEnabled).toBe(false);
    expect(loadSettings({ PIKVM_ML_CASCADE: '1' }).ml.cascadeEnabled).toBe(true);
    expect(loadSettings({ PIKVM_ML_CASCADE: '' }).ml.cascadeEnabled).toBe(true);
  });

  it('boolean flags are true only for the exact string "1"', () => {
    expect(loadSettings({ PIKVM_ML_DISABLE: '1' }).ml.disabled).toBe(true);
    expect(loadSettings({ PIKVM_ML_DISABLE: 'true' }).ml.disabled).toBe(false);
    expect(loadSettings({ PIKVM_ML_V5_PRESENCE_GATE: '1' }).ml.v5PresenceGate).toBe(true);
    expect(loadSettings({ PIKVM_USE_LEARNED_BALLISTICS: '1' }).movement.useLearnedBallistics).toBe(true);
    expect(loadSettings({ PIKVM_DISABLE_RETRY_SKIP_PROBE: '1' }).movement.disableRetrySkipProbe).toBe(true);
    expect(loadSettings({ PIKVM_FORCE_WAKE: '1' }).movement.forceWake).toBe(true);
  });

  it('reads numeric knobs and path overrides', () => {
    const s = loadSettings({
      PIKVM_ML_GRID_STRIDE: '32',
      PIKVM_ML_VERIFY_THRESH: '0.7',
      PIKVM_ML_MODEL: 'ml/alt.onnx',
      PIKVM_ML_V8_MODEL: 'ml/cursor-v13.onnx',
      PIKVM_POINTER_ACCEL_MODEL: 'ml/pa.onnx',
      PIKVM_EMIT_LOG: '/tmp/emit.log',
    });
    expect(s.ml.gridStride).toBe(32);
    expect(s.ml.verifyThresh).toBe(0.7);
    expect(s.ml.model).toBe('ml/alt.onnx');
    expect(s.ml.v8Model).toBe('ml/cursor-v13.onnx');
    expect(s.pointerAccelModel).toBe('ml/pa.onnx');
    expect(s.emitLog).toBe('/tmp/emit.log');
  });

  it('keeps clickMaxResidualPx as the raw string (parsing lives at the call site)', () => {
    expect(loadSettings({ PIKVM_CLICK_MAX_RESIDUAL_PX: 'off' }).movement.clickMaxResidualPxRaw).toBe('off');
    expect(loadSettings({ PIKVM_CLICK_MAX_RESIDUAL_PX: '40' }).movement.clickMaxResidualPxRaw).toBe('40');
    expect(loadSettings({}).movement.clickMaxResidualPxRaw).toBeUndefined();
  });
});

describe('getSettings', () => {
  afterEach(() => resetSettingsForTest());

  it('memoises the first read; resetSettingsForTest() clears it', () => {
    const a = getSettings();
    const b = getSettings();
    expect(a).toBe(b); // same object — memoised
    resetSettingsForTest();
    const c = getSettings();
    expect(c).not.toBe(a); // fresh object after reset
  });
});
