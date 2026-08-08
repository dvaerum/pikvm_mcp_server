/**
 * #51: the HID-mode mover gate. Pins that MODE_SENSITIVE_TOOLS covers the
 * pointer-movers (so a new mover can't silently bypass the fail-closed / settling
 * gate) and EXCLUDES the mode-agnostic tools (keyboard / screenshot / health /
 * recovery still work while the mode is unknown or settling), and that the gate is
 * actually wired into the dispatch preamble. Text-based (reads src/index.ts), same
 * pattern as mcp-tool-schema-exposure.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

async function readIndexTs(): Promise<string> {
  return fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'index.ts'), 'utf8');
}

function modeSensitiveSet(src: string): Set<string> {
  const block = /const MODE_SENSITIVE_TOOLS = new Set<string>\(\[([\s\S]*?)\]\)/.exec(src);
  if (!block) throw new Error('MODE_SENSITIVE_TOOLS not found');
  return new Set([...block[1].matchAll(/'(pikvm_[a-z_]+)'/g)].map((m) => m[1]));
}

describe('#51 HID-mode mover gate', () => {
  // Pointer-driving tools: correctness depends on ipad(relative)/desktop(absolute),
  // and they must refuse while the mode is unknown or mid-switch.
  const MUST_GATE = [
    'pikvm_mouse_move', 'pikvm_mouse_click', 'pikvm_mouse_scroll',
    'pikvm_mouse_move_to', 'pikvm_mouse_click_at',
    'pikvm_calibrate', 'pikvm_auto_calibrate', 'pikvm_measure_ballistics',
    'pikvm_ipad_unlock', 'pikvm_ipad_home', 'pikvm_dismiss_popup',
  ];
  // Mode-agnostic: must stay available even when pointer ops are refused.
  const MUST_NOT_GATE = [
    'pikvm_type', 'pikvm_key', 'pikvm_shortcut',
    'pikvm_screenshot', 'pikvm_health_check', 'pikvm_version',
    'pikvm_hid_recover', 'pikvm_hid_reset', 'pikvm_usb_reconnect',
    'pikvm_hidmode_status', 'pikvm_hidmode_set',
  ];

  it('gates every known pointer-mover', async () => {
    const set = modeSensitiveSet(await readIndexTs());
    for (const t of MUST_GATE) expect(set, `${t} must be mode-gated`).toContain(t);
  });

  it('does NOT gate keyboard / screenshot / health / recovery / hidmode tools', async () => {
    const set = modeSensitiveSet(await readIndexTs());
    for (const t of MUST_NOT_GATE) expect(set, `${t} must NOT be mode-gated`).not.toContain(t);
  });

  it('wires the gate into the dispatch preamble (refresh + moverGate → refuse)', async () => {
    const src = await readIndexTs();
    expect(src).toMatch(/if \(MODE_SENSITIVE_TOOLS\.has\(name\)\)/);
    expect(src).toMatch(/hidModeResolver\?\.moverGate\(\)/);
  });
});
