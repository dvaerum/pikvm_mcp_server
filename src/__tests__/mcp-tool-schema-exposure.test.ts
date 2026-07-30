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

/** Find a tool's handler body. Cand-6 replaced the CallTool `switch` with a
 *  per-tool registry: each tool's handler is a module-level
 *  `async function handle_<toolName>(args)`. Returns that function's source up
 *  to the next handler declaration. */
function extractHandlerBlock(src: string, toolName: string): string {
  const startMarker = `async function handle_${toolName}(`;
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Handler for ${toolName} not found`);
  const after = src.slice(startIdx);
  const nextIdx = after.indexOf('\nasync function handle_', 1);
  return after.slice(0, nextIdx === -1 ? undefined : nextIdx);
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

    it('tap-retry is REMOVED — no maxRetries knob, no clickAtWithRetry call', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_mouse_click_at');
      // The maxRetries schema knob is gone (retry removed 2026-07-28).
      expect(tool).not.toMatch(/maxRetries:\s*\{/);
      const handler = extractHandlerBlock(src, 'pikvm_mouse_click_at');
      // Handler no longer invokes the retry orchestrator.
      expect(handler).not.toContain('clickAtWithRetry(');
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

    it('M6 singleTap defaults minBrightness=0 (retry removed → no maxRetries forcing)', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_mouse_click_at');
      expect(handler).toMatch(/validateBoolean\(args\.singleTap\)/);
      // singleTap defaults the brightness gate off so a dimmed PIN modal doesn't false-abort.
      expect(handler).toMatch(/singleTap \|\| mouseAbsoluteMode \? 0/);
      // Retry is gone, so there is no maxRetries variable to force to 0.
      expect(handler).not.toMatch(/const maxRetries =/);
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

  describe('M8 — before/during/after capture on the mouse tools', () => {
    it('the shared CAPTURE_SCHEMA_PROPS defines capture / capturePrefix / captureRegion', async () => {
      const src = await readIndexTs();
      // capture: string[] enum before|during|after
      expect(src).toMatch(/capture:\s*\{[\s\S]*?enum:\s*\['before',\s*'during',\s*'after'\]/);
      expect(src).toMatch(/capturePrefix:\s*\{[^}]*type:\s*'string'/);
      expect(src).toMatch(/captureRegion:\s*\{[\s\S]*?type:\s*'object'/);
    });

    for (const tool of ['pikvm_mouse_click_at', 'pikvm_mouse_move', 'pikvm_mouse_move_to']) {
      it(`${tool} spreads CAPTURE_SCHEMA_PROPS into its schema`, async () => {
        const src = await readIndexTs();
        const block = extractToolBlock(src, tool);
        expect(block).toMatch(/\.\.\.CAPTURE_SCHEMA_PROPS/);
      });

      it(`${tool} handler parses capture and captures advisorily`, async () => {
        const src = await readIndexTs();
        const handler = extractHandlerBlock(src, tool);
        expect(handler).toMatch(/parseCaptureConfig\(args\)/);
        expect(handler).toMatch(/capturePhaseAdvisory\(/);
      });
    }

    it('click_at (single-attempt path) captures during pre-click and after post-click', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_mouse_click_at');
      // "during" = pre-button-down cursor-alive frame; "after" reuses the
      // post-click screenshot buffer (no retry orchestrator involved).
      expect(handler).toMatch(/capturePhaseAdvisory\(pikvm, capture, 'during'\)/);
      expect(handler).toMatch(/capturePhaseAdvisory\(pikvm, capture, 'after', shot\.buffer\)/);
    });
  });

  // Cand-6: the CallTool `switch(name)` became a per-tool registry — each tool's
  // descriptor is bound to a module-level `handle_<tool>` handler. These are the
  // "nothing lost" proofs: descriptor↔handler colocation for EVERY tool + the
  // registry name set is EXACTLY the old switch's 32 cases (a dropped/renamed
  // case fails here).
  describe('Cand-6 — tool-descriptor registry (switch → toolsByName dispatch)', () => {
    // The exact set of tool cases that lived in the former CallTool switch.
    // Pinned so a lost/renamed/spurious handler trips this test.
    const EXPECTED_TOOLS = [
      'pikvm_version', 'pikvm_health_check', 'pikvm_screenshot', 'pikvm_snapshot',
      'pikvm_get_resolution', 'pikvm_type', 'pikvm_key', 'pikvm_shortcut',
      'pikvm_screen_state', 'pikvm_hid_reset', 'pikvm_hid_recover', 'pikvm_usb_reconnect',
      'pikvm_ipad_unlock_with_code', 'pikvm_ipad_lock', 'pikvm_dismiss_popup',
      'pikvm_mouse_move', 'pikvm_mouse_click', 'pikvm_mouse_scroll', 'pikvm_calibrate',
      'pikvm_set_calibration', 'pikvm_get_calibration', 'pikvm_clear_calibration',
      'pikvm_ipad_unlock', 'pikvm_ipad_launch_app', 'pikvm_detect_orientation',
      'pikvm_ipad_home', 'pikvm_ipad_app_switcher', 'pikvm_mouse_move_to',
      'pikvm_mouse_click_at', 'pikvm_measure_ballistics', 'pikvm_seed_cursor_template',
      'pikvm_auto_calibrate',
    ];

    function registryBlock(src: string): string {
      const start = src.indexOf('const toolRegistry: ToolEntry[] = [');
      if (start === -1) throw new Error('toolRegistry not found');
      const end = src.indexOf('\n];', start);
      return src.slice(start, end);
    }

    it('registry entries appear in binding order name → handler: handle_<name> (colocation)', async () => {
      const src = await readIndexTs();
      const block = registryBlock(src);
      const names = [...block.matchAll(/name: '(pikvm_\w+)',/g)].map((m) => m[1]);
      const handlers = [...block.matchAll(/handler: handle_(pikvm_\w+),/g)].map((m) => m[1]);
      // Every descriptor is immediately bound to its correctly-named handler,
      // in the same order → exact 1:1 colocation.
      expect(handlers).toEqual(names);
    });

    it('registry name set is EXACTLY the former switch case set (nothing dropped/renamed/added)', async () => {
      const src = await readIndexTs();
      const names = [...registryBlock(src).matchAll(/name: '(pikvm_\w+)',/g)].map((m) => m[1]);
      expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort());
      expect(names).toHaveLength(EXPECTED_TOOLS.length);
    });

    it('every bound handler is a defined module-level function', async () => {
      const src = await readIndexTs();
      for (const name of EXPECTED_TOOLS) {
        expect(src).toContain(`handler: handle_${name},`);
        expect(src).toContain(`async function handle_${name}(args: Record<string, unknown>): Promise<CallToolResult>`);
      }
    });

    it('dispatch routes via toolsByName and preserves the unknown-tool throw; no switch remains', async () => {
      const src = await readIndexTs();
      // Skill tools still short-circuit BEFORE the registry lookup (preamble intact).
      expect(src).toMatch(/if \(isSkillTool\(name\)\) \{\s*\n\s*return handleSkillToolCall\(name, args\);/);
      // Registry dispatch + unknown-tool parity with the old `default:`.
      expect(src).toMatch(/const entry = toolsByName\.get\(name\);/);
      expect(src).toMatch(/if \(!entry\) \{\s*\n\s*throw new Error\(`Unknown tool: \$\{name\}`\);/);
      expect(src).toMatch(/return await entry\.handler\(args as Record<string, unknown>\);/);
      // The switch is gone.
      expect(src).not.toContain('switch (name) {');
    });
  });

  // False-success safety fix: pikvm_mouse_click_at must never report a click it
  // did not send. Both paths gate on a verified cursor.
  describe('false-success safety — click_at reports not-landed, never blind-fires', () => {
    it('single-shot path skips + isError when the cursor is unverified on iPad', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_mouse_click_at');
      // iPad-only gate: null finalDetectedPosition → NOT-LANDED before any click.
      expect(handler).toMatch(/!mouseAbsoluteMode && result\.finalDetectedPosition === null/);
      expect(handler).toMatch(/Click NOT performed/);
    });

    it('migrated maxResidualPx correct-element gate skips an off-target click', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_mouse_click_at');
      // Phase-88 gate re-homed from the removed retry path into the single
      // path: a verified-but-too-far cursor is a not-landed skip, not a click.
      expect(handler).toMatch(/residualForSkip\(/);
      expect(handler).toMatch(/maxResidualPx !== undefined && maxResidualPx > 0/);
      expect(handler).toContain('adjacent element');
    });

    // The #34 regression fix: an explicit `force` escape hatch to click at the
    // predicted position when the cursor can't be localized — but LOUD and
    // never silently read as a landing. Default (no force) still skips.
    it('force escape hatch is in the schema and gated explicitly', async () => {
      const src = await readIndexTs();
      const tool = extractToolBlock(src, 'pikvm_mouse_click_at');
      expect(tool).toMatch(/force:\s*\{[^}]*type:\s*'boolean'/);
      const handler = extractHandlerBlock(src, 'pikvm_mouse_click_at');
      // Explicitly parsed, not silently ignored.
      expect(handler).toMatch(/const force = validateBoolean\(args\.force\)/);
      // The null-detection skip only fires WITHOUT force → force falls through
      // to the click.
      expect(handler).toMatch(/result\.finalDetectedPosition === null && !force/);
    });

    it('a forced click is reported UNVERIFIED, never as a plain landing', async () => {
      const src = await readIndexTs();
      const handler = extractHandlerBlock(src, 'pikvm_mouse_click_at');
      expect(handler).toMatch(/const forcedUnverified = /);
      // The forced-click line must be loudly distinguishable from a landing.
      expect(handler).toMatch(/forcedUnverified\s*\n?\s*\?/);
      expect(handler).toContain('UNVERIFIED');
      expect(handler).toContain('LANDING IS NOT CONFIRMED');
      // ...and force must NOT touch the maxResidualPx (wrong-element) gate:
      // that gate only runs when finalDetectedPosition is non-null.
      expect(handler).toMatch(/!mouseAbsoluteMode && result\.finalDetectedPosition\)/);
    });
  });
});
