/**
 * Regression test for the locality-gate contract in moveToPixel.
 *
 * Phase 197 (v0.5.193) introduced `requireWithinRadius: true` on
 * the open-loop template-search path so that when no template
 * match falls within `expectedNearRadius` of the cursor hint, the
 * function returns null instead of falling back to the highest-
 * scoring match anywhere on screen (which is exactly the iPad UI
 * false-positive class — clock widget, calendar widget, etc.).
 *
 * Phase 244 (v0.5.211) extended this to the correction-pass
 * template fallback after Phase 243 documented the bimodal
 * detection failure: confident-wrong matches at iPad UI features
 * far from the real cursor.
 *
 * This test pins BOTH gates by source-text scan. It's intentionally
 * fragile to source-rewriting — if a future refactor renames the
 * option or moves the call sites, this test fires and forces a
 * conscious re-validation of the contract.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

function repoRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..', '..');
}

async function readMoveToTs(): Promise<string> {
  return fs.readFile(path.join(repoRoot(), 'src', 'pikvm', 'move-to.ts'), 'utf8');
}

describe('moveToPixel locality-gate pinning', () => {
  it('Phase 197 + Phase 244: requireWithinRadius:true appears in BOTH open-loop and correction-pass paths', async () => {
    const src = await readMoveToTs();
    // Match the option-set form, not the comment mention. The
    // pattern `requireWithinRadius: true,` matches the actual
    // option assignment.
    const matches = src.match(/requireWithinRadius:\s*true\s*,/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('Phase 197 reference is preserved in the open-loop gate context', async () => {
    const src = await readMoveToTs();
    // The Phase 197 introduction is directly above the open-loop
    // requireWithinRadius. If someone deletes the comment context,
    // the rationale is lost and the test fires.
    expect(src).toMatch(/Phase 197[^\n]*\n[\s\S]{0,800}requireWithinRadius:\s*true/);
  });

  it('Phase 244 reference is preserved in the correction-pass gate context', async () => {
    const src = await readMoveToTs();
    // Same pattern for Phase 244's correction-pass gate.
    expect(src).toMatch(/Phase 244[^\n]*\n[\s\S]{0,800}requireWithinRadius:\s*true/);
  });

  it('Phase 248: fpBlocklist option threaded into BOTH call sites', async () => {
    const src = await readMoveToTs();
    // Phase 248 introduced fpBlocklist on FindCursorOptions and
    // threaded it through MoveToOptions. Both findCursorByTemplateSet
    // call sites in move-to.ts must pass `fpBlocklist:
    // options.fpBlocklist` so callers' blocklists actually apply.
    // If someone removes one of the two lines, the option silently
    // stops working at that callsite.
    const matches = src.match(/fpBlocklist:\s*options\.fpBlocklist/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('Phase 250: scoreMargin option threaded into BOTH call sites', async () => {
    const src = await readMoveToTs();
    // Phase 250 introduced scoreMargin on FindCursorOptions and
    // threaded it through MoveToOptions. Same shape as Phase 248.
    const matches = src.match(/scoreMargin:\s*options\.scoreMargin/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('Phase 251: topK diagnostic option threaded into BOTH call sites', async () => {
    const src = await readMoveToTs();
    // Phase 251 introduced topK on FindCursorOptions (diagnostic-only,
    // logs per-template top-K with verbose) and threaded it through
    // MoveToOptions. Same shape as Phase 248/250. If a future refactor
    // drops the threading, verbose logs lose the top-K context and
    // future template-match investigations lose the lever.
    const matches = src.match(/topK:\s*options\.topK/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('expectedNearRadius is set on both paths (anchors the locality check)', async () => {
    const src = await readMoveToTs();
    // The locality gate is meaningless without a radius. Both call
    // sites set expectedNearRadius — the open-loop uses 200, the
    // correction-pass uses 150. Pin that BOTH are present.
    const matches = src.match(/expectedNearRadius:\s*\d+/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
