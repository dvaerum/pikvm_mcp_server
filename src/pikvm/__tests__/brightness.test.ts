/**
 * Phase 37 — brightness analysis for cursor-detection diagnostics.
 *
 * Pin the threshold logic + report shape so future edits don't accidentally
 * silence the dim-screen warning the operator depends on to diagnose the
 * "cursor detection always fails" failure mode.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  analyzeBrightness,
  classifyBrightness,
  formatBrightnessReport,
  DIM_THRESHOLD,
  VERY_DIM_THRESHOLD,
} from '../brightness.js';

async function uniformJpeg(width: number, height: number, gray: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3, gray);
  return sharp(data, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

describe('classifyBrightness', () => {
  it('classifies very-dim below VERY_DIM_THRESHOLD', () => {
    const r = classifyBrightness(VERY_DIM_THRESHOLD - 10);
    expect(r.severity).toBe('very-dim');
    expect(r.hint).toMatch(/VERY DIM/);
    expect(r.hint).toMatch(/wake the screen/i);
  });

  it('classifies dim between VERY_DIM_THRESHOLD and DIM_THRESHOLD', () => {
    const r = classifyBrightness((VERY_DIM_THRESHOLD + DIM_THRESHOLD) / 2);
    expect(r.severity).toBe('dim');
    expect(r.hint).toMatch(/⚠ DIM/);
    expect(r.hint).not.toMatch(/VERY DIM/);
  });

  it('classifies normal at and above DIM_THRESHOLD', () => {
    expect(classifyBrightness(DIM_THRESHOLD).severity).toBe('normal');
    expect(classifyBrightness(DIM_THRESHOLD).hint).toBe('');
    expect(classifyBrightness(200).severity).toBe('normal');
    expect(classifyBrightness(200).hint).toBe('');
  });

  it('boundary: just below VERY_DIM_THRESHOLD is very-dim', () => {
    expect(classifyBrightness(VERY_DIM_THRESHOLD - 0.1).severity).toBe('very-dim');
  });

  it('boundary: just below DIM_THRESHOLD is dim (not very-dim)', () => {
    expect(classifyBrightness(DIM_THRESHOLD - 0.1).severity).toBe('dim');
  });
});

describe('analyzeBrightness', () => {
  it('reports very-dim severity for a uniform black-ish frame (gray=30)', async () => {
    const buf = await uniformJpeg(200, 200, 30);
    const report = await analyzeBrightness(buf);
    expect(report.mean).toBeGreaterThanOrEqual(20);
    expect(report.mean).toBeLessThan(VERY_DIM_THRESHOLD);
    expect(report.severity).toBe('very-dim');
    expect(report.hint).toMatch(/VERY DIM/);
  });

  it('reports dim severity for a mid-low-luminance frame (gray=65)', async () => {
    const buf = await uniformJpeg(200, 200, 65);
    const report = await analyzeBrightness(buf);
    expect(report.severity).toBe('dim');
    expect(report.hint).toMatch(/⚠ DIM/);
  });

  it('reports normal severity for a well-lit frame (gray=180)', async () => {
    const buf = await uniformJpeg(200, 200, 180);
    const report = await analyzeBrightness(buf);
    expect(report.severity).toBe('normal');
    expect(report.hint).toBe('');
  });

  it('per-channel means are populated', async () => {
    const buf = await uniformJpeg(100, 100, 100);
    const report = await analyzeBrightness(buf);
    expect(report.meanR).toBeGreaterThan(0);
    expect(report.meanG).toBeGreaterThan(0);
    expect(report.meanB).toBeGreaterThan(0);
  });
});

describe('formatBrightnessReport', () => {
  it('includes mean, per-channel values, and the hint when present', () => {
    const line = formatBrightnessReport({
      mean: 40,
      meanR: 38,
      meanG: 42,
      meanB: 40,
      severity: 'very-dim',
      hint: ' ⚠ VERY DIM — wake the screen.',
    });
    expect(line).toMatch(/Screen brightness/);
    expect(line).toMatch(/mean=40\/255/);
    expect(line).toMatch(/R=38/);
    expect(line).toMatch(/G=42/);
    expect(line).toMatch(/B=40/);
    expect(line).toMatch(/VERY DIM/);
  });

  it('omits hint visually when severity is normal', () => {
    const line = formatBrightnessReport({
      mean: 150,
      meanR: 150,
      meanG: 150,
      meanB: 150,
      severity: 'normal',
      hint: '',
    });
    expect(line).toMatch(/Screen brightness/);
    expect(line).not.toMatch(/⚠/);
    expect(line).not.toMatch(/DIM/);
  });
});
