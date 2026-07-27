/**
 * Phase 241 regression test: pin the MCP exposure of the
 * Phase 217/219/214/231/235 unlock/home options.
 *
 * Phase 238/239 fixed a silently-growing gap: pikvm_ipad_unlock and
 * pikvm_ipad_home had library options (`tryKeyPressFirst`,
 * `swipeOnKeyPressFailure`, `forceHomeViaSwipe`, `swipeDragPx`) that
 * weren't reachable from the MCP tool surface for years. This test
 * pins both the schema declaration AND the handler forwarding so a
 * future regression (someone deleting a property or stopping the
 * `validateBoolean(args.x)` line) fails a test instead of silently
 * regressing the MCP API.
 *
 * Reads src/index.ts as text — same pattern used by
 * agents-doc-freshness.test.ts for the tool-count assertions.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

function repoRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..');
}

async function readIndexTs(): Promise<string> {
  return fs.readFile(path.join(repoRoot(), 'src', 'index.ts'), 'utf8');
}

/** Find a tool's full block by `name: '<toolName>'` and return everything
 *  up to the next standalone `},\n  {` separator. */
function extractToolBlock(src: string, toolName: string): string {
  const startMarker = `name: '${toolName}',`;
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Tool ${toolName} not found in src/index.ts`);
  // Walk forward until we hit the next tool-block opener (`  {`) or the
  // closing of the tools array.
  const after = src.slice(startIdx);
  // Stop at the next `name: 'pikvm_…'` definition or `];` (end of array).
  const nextNameIdx = after.indexOf("\n    name: 'pikvm_", 1);
  const arrayEndIdx = after.indexOf('\n];');
  const stopAt =
    nextNameIdx === -1
      ? arrayEndIdx
      : arrayEndIdx === -1
      ? nextNameIdx
      : Math.min(nextNameIdx, arrayEndIdx);
  return after.slice(0, stopAt === -1 ? undefined : stopAt);
}

/** Find a handler's case block by `case '<toolName>':`. Returns the body
 *  until the matching `}` of the inner block. Approximation: stops at
 *  next `case '` keyword. */
function extractHandlerBlock(src: string, toolName: string): string {
  const startMarker = `case '${toolName}':`;
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Handler for ${toolName} not found`);
  const after = src.slice(startIdx);
  const nextCaseIdx = after.indexOf("\n      case '", 1);
  return after.slice(0, nextCaseIdx === -1 ? undefined : nextCaseIdx);
}

describe('MCP tool schema and handler exposure', () => {
  describe('pikvm_ipad_unlock — Phase 217/219 options exposed (Phase 238/239)', () => {
    it('schema declares tryKeyPressFirst', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_ipad_unlock');
      expect(tool).toMatch(/tryKeyPressFirst:\s*\{[^}]*type:\s*'boolean'/);
    });

    it('schema declares swipeOnKeyPressFailure', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_ipad_unlock');
      expect(tool).toMatch(/swipeOnKeyPressFailure:\s*\{[^}]*type:\s*'boolean'/);
    });

    it('handler forwards tryKeyPressFirst via validateBoolean', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_ipad_unlock');
      expect(handler).toMatch(/tryKeyPressFirst:\s*validateBoolean\(args\.tryKeyPressFirst\)/);
    });

    it('handler forwards swipeOnKeyPressFailure via validateBoolean', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_ipad_unlock');
      expect(handler).toMatch(/swipeOnKeyPressFailure:\s*validateBoolean\(args\.swipeOnKeyPressFailure\)/);
    });
  });

  describe('pikvm_ipad_home — Phase 214/231/235 options exposed (Phase 238)', () => {
    it('schema declares forceHomeViaSwipe', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_ipad_home');
      expect(tool).toMatch(/forceHomeViaSwipe:\s*\{[^}]*type:\s*'boolean'/);
    });

    it('schema declares swipeDragPx', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_ipad_home');
      expect(tool).toMatch(/swipeDragPx:\s*\{[^}]*type:\s*'number'/);
    });

    it('handler forwards forceHomeViaSwipe via validateBoolean', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_ipad_home');
      expect(handler).toMatch(/forceHomeViaSwipe:\s*validateBoolean\(args\.forceHomeViaSwipe\)/);
    });

    it('handler forwards swipeDragPx via validateNumber', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_ipad_home');
      expect(handler).toMatch(/swipeDragPx:\s*validateNumber\(args\.swipeDragPx/);
    });
  });

  describe('pikvm_screenshot — Phase 202 keepalive variant exposed (Phase 246)', () => {
    it('schema declares keepCursorAlive', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_screenshot');
      expect(tool).toMatch(/keepCursorAlive:\s*\{[^}]*type:\s*'boolean'/);
    });

    it('handler routes to screenshotKeepingCursorAlive when keepCursorAlive is true', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_screenshot');
      // Pattern: validateBoolean(args.keepCursorAlive) ? screenshotKeepingCursorAlive(opts) : screenshot(opts)
      expect(handler).toMatch(/validateBoolean\(args\.keepCursorAlive\)/);
      expect(handler).toMatch(/screenshotKeepingCursorAlive/);
    });
  });

  describe('pikvm_mouse_click_at — phase-tagged production options exposed', () => {
    // The four most-load-bearing options (each with measurable user
    // impact documented in its Phase troubleshooting note).
    // Removing any would silently regress production behavior.

    it('Phase 88 maxResidualPx is in the schema', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_mouse_click_at');
      expect(tool).toMatch(/maxResidualPx:\s*\{[^}]*type:\s*'number'/);
    });

    it('Phase 38 minBrightness is in the schema', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_mouse_click_at');
      expect(tool).toMatch(/minBrightness:\s*\{[^}]*type:\s*'number'/);
    });

    it('Phase 72 autoUnlockOnDetectFail is in the schema', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_mouse_click_at');
      expect(tool).toMatch(/autoUnlockOnDetectFail:\s*\{[^}]*type:\s*'boolean'/);
    });

    it('Phase 25 maxRetries is in the schema', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_mouse_click_at');
      expect(tool).toMatch(/maxRetries:\s*\{[^}]*type:\s*'number'/);
    });

    it('verifyClick (Phase 23 verification) is in the schema', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_mouse_click_at');
      expect(tool).toMatch(/verifyClick:\s*\{[^}]*type:\s*'boolean'/);
    });

    it('M6 singleTap is in the schema (keypad mode)', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_mouse_click_at');
      expect(tool).toMatch(/singleTap:\s*\{[^}]*type:\s*'boolean'/);
    });

    it('M6 handler forces maxRetries=0 and defaults minBrightness=0 under singleTap', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_mouse_click_at');
      expect(handler).toMatch(/validateBoolean\(args\.singleTap\)/);
      // singleTap forces the single-shot (no-retry) path...
      expect(handler).toMatch(/singleTap[\s\S]{0,40}\?\s*0/);
      // ...and defaults the brightness gate off so a dimmed PIN modal doesn't false-abort.
      expect(handler).toMatch(/singleTap \|\| mouseAbsoluteMode \? 0/);
    });

    it('M6 expectRegion object is in the schema (x,y,width,height)', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_mouse_click_at');
      expect(tool).toMatch(/expectRegion:\s*\{[\s\S]*?type:\s*'object'/);
      const expectRegionBlock = tool.slice(tool.indexOf('expectRegion:'));
      for (const key of ['x', 'y', 'width', 'height']) {
        expect(expectRegionBlock).toMatch(new RegExp(`${key}:\\s*\\{[^}]*type:\\s*'number'`));
      }
    });

    it('M6 handler parses expectRegion and forwards it as regionRect (precedence)', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_mouse_click_at');
      // Parsed from args into a rectangular box...
      expect(handler).toMatch(/args\.expectRegion/);
      expect(handler).toMatch(/requireNumber\(er\.width, 'expectRegion\.width'\)/);
      // ...and fed to the verify layer as regionRect, which takes precedence
      // over the target-centered `region` inside verifyClickByDecodedFrames.
      expect(handler).toMatch(/regionRect:\s*expectRegion/);
    });

  });

  describe('pikvm_mouse_scroll — M1 pane targeting (optional x,y)', () => {
    it('schema declares x and y (numbers)', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_mouse_scroll');
      expect(tool).toMatch(/x:\s*\{[^}]*type:\s*'number'/);
      expect(tool).toMatch(/y:\s*\{[^}]*type:\s*'number'/);
      // deltaX/deltaY are preserved.
      expect(tool).toMatch(/deltaY:\s*\{[^}]*type:\s*'number'/);
    });

    it('handler reads x/y via validateNumber and positions before scrolling', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_mouse_scroll');
      expect(handler).toMatch(/validateNumber\(args\.x\)/);
      expect(handler).toMatch(/validateNumber\(args\.y\)/);
      // M1 fix: pane targeting routes through the platform-aware moveToPixel
      // (curve-one-shot relative emits on iPad), NOT raw pikvm.mouseMove —
      // iPadOS ignores absolute positioning so the raw move was a no-op.
      expect(handler).toMatch(/moveToPixel\(pikvm,/);
      expect(handler).toMatch(/!mouseAbsoluteMode \? 'curve-one-shot' : 'detect-then-move'/);
      // The raw absolute mouseMove must NOT be used for pane targeting.
      expect(handler).not.toMatch(/pikvm\.mouseMove\(/);
      expect(handler).toMatch(/pikvm\.mouseScroll\(/);
      // The positioning move must be issued BEFORE the scroll.
      expect(handler.indexOf('moveToPixel(pikvm,')).toBeLessThan(handler.indexOf('pikvm.mouseScroll('));
    });

    it('handler rejects x-without-y (and vice versa)', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_mouse_scroll');
      expect(handler).toMatch(/\(tx === undefined\) !== \(ty === undefined\)/);
    });
  });

  describe('pikvm_snapshot — M5 save-to-file', () => {
    it('schema declares required savePath and optional region', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_snapshot');
      expect(tool).toMatch(/savePath:\s*\{[^}]*type:\s*'string'/);
      expect(tool).toMatch(/region:\s*\{[^]*?type:\s*'object'/);
      expect(tool).toMatch(/required:\s*\['savePath'\]/);
    });

    it('handler requires savePath and delegates to saveSnapshot', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_snapshot');
      expect(handler).toMatch(/requireString\(args\.savePath/);
      expect(handler).toMatch(/saveSnapshot\(/);
    });

    it('pikvm_screenshot handler honors an optional savePath (M5 inline case)', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_screenshot');
      expect(handler).toMatch(/validateString\(args\.savePath\)/);
      expect(handler).toMatch(/saveSnapshot\(/);
    });
  });

  describe('pikvm_usb_reconnect — M0 (capped-rung usb reconnect)', () => {
    it('schema declares optional settleMs (no required destructive args)', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_usb_reconnect');
      expect(tool).toMatch(/settleMs:\s*\{[^}]*type:\s*'number'/);
      // Dead-simple: must NOT expose allowReboot/maxRung (those belong to pikvm_hid_recover).
      expect(tool).not.toMatch(/allowReboot:/);
      expect(tool).not.toMatch(/maxRung:/);
    });

    it('handler runs recoverHid capped at udc-rebind, skipping the no-op R1', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_usb_reconnect');
      expect(handler).toMatch(/skipSoftReset:\s*true/);
      expect(handler).toMatch(/maxRung:\s*3/);
      expect(handler).toMatch(/allowReboot:\s*false/);
      // Verifies via the ground-truth UDC-state reader AND behavioral, and reports rungUsed.
      expect(handler).toMatch(/getUdcStateReader\(\)/);
      expect(handler).toMatch(/makeBehavioralVerifier\(/);
      expect(handler).toMatch(/rungUsed/);
    });
  });
});
