/**
 * Phase 248 unit tests for the false-positive blocklist helper.
 */

import { describe, expect, it } from 'vitest';
import {
  KNOWN_HOME_SCREEN_FPS_1680x1050,
  isWithinKnownFp,
} from '../cursor-fp-blocklist.js';

describe('isWithinKnownFp', () => {
  const blocklist = {
    centers: [
      { x: 100, y: 100 },
      { x: 500, y: 500 },
    ],
    radius: 50,
  };

  it('returns true for exact center', () => {
    expect(isWithinKnownFp({ x: 100, y: 100 }, blocklist)).toBe(true);
  });

  it('returns true for position within radius', () => {
    // 30 px away — well within 50 px radius
    expect(isWithinKnownFp({ x: 130, y: 100 }, blocklist)).toBe(true);
  });

  it('returns true at exactly radius distance', () => {
    expect(isWithinKnownFp({ x: 150, y: 100 }, blocklist)).toBe(true);
  });

  it('returns false just outside radius', () => {
    expect(isWithinKnownFp({ x: 151, y: 100 }, blocklist)).toBe(false);
  });

  it('returns false for far position', () => {
    expect(isWithinKnownFp({ x: 1000, y: 1000 }, blocklist)).toBe(false);
  });

  it('matches second blocklist entry', () => {
    expect(isWithinKnownFp({ x: 510, y: 490 }, blocklist)).toBe(true);
  });

  it('returns false when blocklist is undefined', () => {
    expect(isWithinKnownFp({ x: 100, y: 100 }, undefined)).toBe(false);
  });

  it('returns false when blocklist has no centers', () => {
    expect(isWithinKnownFp({ x: 100, y: 100 }, { centers: [], radius: 50 })).toBe(false);
  });
});

describe('KNOWN_HOME_SCREEN_FPS_1680x1050', () => {
  it('contains the Phase 247 identified FP locations', () => {
    const positions = KNOWN_HOME_SCREEN_FPS_1680x1050.centers;
    // (852, 941) — wallpaper-gradient FP between icons row and dock
    expect(positions).toContainEqual({ x: 852, y: 941 });
    // (773, 769) — TV app icon glyph correlation
    expect(positions).toContainEqual({ x: 773, y: 769 });
    // (782, 958) — dock area near page indicator
    expect(positions).toContainEqual({ x: 782, y: 958 });
  });

  it('uses 50 px radius (covers Phase 247 cluster spread)', () => {
    expect(KNOWN_HOME_SCREEN_FPS_1680x1050.radius).toBe(50);
  });

  it('rejects positions near the (852, 941) wallpaper FP', () => {
    expect(isWithinKnownFp({ x: 852, y: 941 }, KNOWN_HOME_SCREEN_FPS_1680x1050)).toBe(true);
    expect(isWithinKnownFp({ x: 870, y: 960 }, KNOWN_HOME_SCREEN_FPS_1680x1050)).toBe(true);
  });

  it('does NOT reject the (905, 800) Settings target region', () => {
    expect(isWithinKnownFp({ x: 905, y: 800 }, KNOWN_HOME_SCREEN_FPS_1680x1050)).toBe(false);
  });
});
