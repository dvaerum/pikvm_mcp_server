/**
 * #3 (secondary, off #51): the mirror of the absolute-mouse gate. ABSOLUTE_MOUSE_GATE
 * refuses absolute-requiring calls when the target is in relative/iPad mode; this pins
 * the symmetric RELATIVE_MOUSE_GATE, which refuses a FORCED relative:true emit
 * (pikvm_mouse_move) when the target is in absolute/desktop mode — a documented silent
 * no-op (ADR 0002; live-confirmed by it-03400 2026-08-10, zero pixel change).
 *
 * Text-based (reads src/index.ts), same pattern as mcp-hidmode-gate.test.ts:
 * hidModeResolver is a module-level singleton only populated by main()/a real
 * device (currentMouseAbsolute is derived from it fresh per dispatch call, see
 * hid-policy.test.ts for the policy() unit coverage), so a behavioral in-
 * memory-client test can't drive mouseAbsolute=true without a live target —
 * the same structural reason that file's dispatch-wiring test is source-based,
 * not behavioral.
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

async function readIndexTs(): Promise<string> {
  return fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'index.ts'), 'utf8');
}

describe('#3 relative-into-absolute mover gate (symmetric with ABSOLUTE_MOUSE_GATE)', () => {
  it('defines RELATIVE_MOUSE_GATE as the exact logical mirror of the absolute gate for pikvm_mouse_move', async () => {
    const src = await readIndexTs();
    // Absolute gate: requires absolute UNLESS relative:true was passed.
    expect(src).toMatch(/pikvm_mouse_move:\s*\(args\)\s*=>\s*args\.relative\s*!==\s*true/);
    // Relative gate: requires relative ONLY WHEN relative:true was passed — the mirror.
    expect(src).toMatch(/pikvm_mouse_move:\s*\(args\)\s*=>\s*args\.relative\s*===\s*true/);
  });

  it('defines requiresRelativeMouse alongside requiresAbsoluteMouse', async () => {
    const src = await readIndexTs();
    expect(src).toMatch(/function requiresRelativeMouse\(name: string, args: Record<string, unknown>\): boolean/);
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
