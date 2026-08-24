/**
 * #51: the HID-mode mover gate. Pins that MODE_SENSITIVE_TOOLS covers the
 * pointer-movers (so a new mover can't silently bypass the fail-closed / settling
 * gate) and EXCLUDES the mode-agnostic tools (keyboard / screenshot / health /
 * recovery still work while the mode is unknown or settling), and that the gate is
 * actually wired into the dispatch preamble.
 *
 * F6 (architecture review): rewritten from text-grepping src/index.ts's
 * MODE_SENSITIVE_TOOLS literal to a real import of the registry-derived Set —
 * same intent (pin which tools are mode-gated), actually testing the thing now
 * instead of grepping source text for it. MODE_SENSITIVE_TOOLS is derived from
 * each tool's own `capabilities.modeSensitive` declaration (see
 * tool-capabilities-equivalence's now-deleted proof and hid-policy.test.ts for
 * adjacent coverage), so this test also indirectly covers that derivation.
 * The dispatch-preamble wiring check stays text-based — that's about verifying
 * actual control-flow structure, not registry data.
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { MODE_SENSITIVE_TOOLS, toolRegistry } from '../index.js';

async function readIndexTs(): Promise<string> {
  return fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'index.ts'), 'utf8');
}

describe('#51 HID-mode mover gate', () => {
  // The FULL expected set — every pointer-driving tool whose correctness
  // depends on ipad(relative)/desktop(absolute), which must refuse while the
  // mode is unknown or mid-switch. Asserted as an exact set (not a subset
  // containment check) so a tool silently dropped from capabilities.modeSensitive
  // fails this test just as loudly as one silently added.
  const EXPECTED_MODE_SENSITIVE = [
    'pikvm_mouse_move', 'pikvm_mouse_click', 'pikvm_mouse_scroll',
    'pikvm_mouse_move_to', 'pikvm_mouse_click_at',
    'pikvm_calibrate', 'pikvm_auto_calibrate', 'pikvm_measure_ballistics',
    'pikvm_seed_cursor_template',
    'pikvm_ipad_unlock', 'pikvm_ipad_unlock_with_code', 'pikvm_ipad_lock',
    'pikvm_ipad_home', 'pikvm_ipad_app_switcher', 'pikvm_ipad_launch_app',
    'pikvm_dismiss_popup',
  ].sort();
  // Mode-agnostic: must stay available even when pointer ops are refused.
  const MUST_NOT_GATE = [
    'pikvm_type', 'pikvm_key', 'pikvm_shortcut',
    'pikvm_screenshot', 'pikvm_health_check', 'pikvm_version',
    'pikvm_hid_recover', 'pikvm_hid_reset', 'pikvm_usb_reconnect',
    'pikvm_hidmode_status', 'pikvm_hidmode_set',
    // The 3 calibration CRUD tools deliberately require absolute mode
    // (capabilities.requiresAbsolute) but are NOT mode-sensitive — they
    // don't move the pointer, so they don't need the settling/unknown gate.
    'pikvm_set_calibration', 'pikvm_get_calibration', 'pikvm_clear_calibration',
  ];

  it('MODE_SENSITIVE_TOOLS is EXACTLY the expected set of pointer-movers — no more, no less', () => {
    expect([...MODE_SENSITIVE_TOOLS].sort()).toEqual(EXPECTED_MODE_SENSITIVE);
  });

  it('does NOT gate keyboard / screenshot / health / recovery / hidmode / calibration-CRUD tools', () => {
    for (const t of MUST_NOT_GATE) expect(MODE_SENSITIVE_TOOLS, `${t} must NOT be mode-gated`).not.toContain(t);
  });

  it('every tool in MODE_SENSITIVE_TOOLS actually exists in the registry (no stale/mistyped names)', () => {
    const registryNames = new Set(toolRegistry.map((e) => e.name));
    for (const name of MODE_SENSITIVE_TOOLS) {
      expect(registryNames, `${name} in MODE_SENSITIVE_TOOLS must be a real registered tool`).toContain(name);
    }
  });

  it('MODE_SENSITIVE_TOOLS agrees exactly with capabilities.modeSensitive on every registry entry', () => {
    for (const entry of toolRegistry) {
      expect(MODE_SENSITIVE_TOOLS.has(entry.name), `${entry.name}: capabilities.modeSensitive=${entry.capabilities.modeSensitive}`)
        .toBe(entry.capabilities.modeSensitive);
    }
  });

  it('wires the gate into the dispatch preamble (refresh + moverGate → refuse)', async () => {
    const src = await readIndexTs();
    expect(src).toMatch(/if \(MODE_SENSITIVE_TOOLS\.has\(name\)\)/);
    expect(src).toMatch(/hidModeResolver\?\.moverGate\(\)/);
  });
});
