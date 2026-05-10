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
});
