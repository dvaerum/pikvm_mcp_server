/**
 * #3 (secondary, off #51): the mirror of the absolute-mouse gate. requiresAbsoluteMouse
 * refuses absolute-requiring calls when the target is in relative/iPad mode; this pins
 * the symmetric requiresRelativeMouse, which refuses a FORCED relative:true emit
 * (pikvm_mouse_move) when the target is in absolute/desktop mode — a documented silent
 * no-op (ADR 0002; live-confirmed by it-03400 2026-08-10, zero pixel change).
 *
 * F6 (architecture review): pikvm_mouse_move's requiresAbsolute/requiresRelative
 * predicates and the requiresAbsoluteMouse/requiresRelativeMouse lookup functions
 * are real exports off src/index.ts now (previously only reachable by grepping the
 * source for the old ABSOLUTE_MOUSE_GATE/RELATIVE_MOUSE_GATE object literals) — the
 * first two tests below are real behavioral imports. The dispatch-preamble wiring
 * test stays text-based: hidModeResolver is a module-level singleton only populated
 * by main()/a real device, so a behavioral in-memory-client test can't drive
 * mouseAbsolute=true without a live target (see hid-policy.test.ts for policy()'s
 * own unit coverage of the mode-derivation logic that feeds this gate).
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { requiresAbsoluteMouse, requiresRelativeMouse } from '../index.js';

async function readIndexTs(): Promise<string> {
  return fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'index.ts'), 'utf8');
}

describe('#3 relative-into-absolute mover gate (symmetric with requiresAbsoluteMouse)', () => {
  it('pikvm_mouse_move: exact logical mirror — requiresAbsolute unless relative:true, requiresRelative only when relative:true', () => {
    expect(requiresAbsoluteMouse('pikvm_mouse_move', {})).toBe(true);
    expect(requiresAbsoluteMouse('pikvm_mouse_move', { relative: true })).toBe(false);
    expect(requiresAbsoluteMouse('pikvm_mouse_move', { relative: false })).toBe(true);

    expect(requiresRelativeMouse('pikvm_mouse_move', {})).toBe(false);
    expect(requiresRelativeMouse('pikvm_mouse_move', { relative: true })).toBe(true);
    expect(requiresRelativeMouse('pikvm_mouse_move', { relative: false })).toBe(false);
  });

  it('requiresRelativeMouse defaults to false for tools with no requiresRelative predicate', () => {
    expect(requiresRelativeMouse('pikvm_mouse_click_at', {})).toBe(false);
    expect(requiresRelativeMouse('pikvm_unknown_tool', {})).toBe(false);
  });

  it('wires the gate into the dispatch preamble, symmetric with the absolute-mode check', async () => {
    const src = await readIndexTs();
    // ADR-0002 Phase 1: currentMouseAbsolute is read once via hidModeResolver
    // .policy() (see the const above these checks) instead of a module global,
    // but the symmetric if/if shape is unchanged.
    // The existing absolute-mode check: refuse when !currentMouseAbsolute && requiresAbsoluteMouse.
    expect(src).toMatch(/if \(!currentMouseAbsolute\) \{\s*\n\s*if \(requiresAbsoluteMouse\(name, args as Record<string, unknown>\)\) \{/);
    // The new mirror: refuse when currentMouseAbsolute && requiresRelativeMouse.
    expect(src).toMatch(/if \(currentMouseAbsolute\) \{\s*\n\s*if \(requiresRelativeMouse\(name, args as Record<string, unknown>\)\) \{/);
  });

  it('the refusal text names the tool and points at absolute-pixel / move_to alternatives', async () => {
    const src = await readIndexTs();
    expect(src).toMatch(/requires relative-mode mouse\. \$\{RELATIVE_MOUSE_NOTE\}/);
    expect(src).toMatch(/RELATIVE_MOUSE_NOTE =\s*\n\s*'This target reports mouse\.absolute=true/);
    expect(src).toMatch(/documented silent no-op \(see ADR 0002/);
  });
});
