/**
 * F6 (architecture review): tool-guides.ts (672 lines) documents each tool's
 * parameters in hand-written markdown prose alongside the JSON schema in
 * index.ts's registry — a second, independent copy of the same parameter
 * list, prone to silent drift (confirmed: a `dragPx` default was tripled
 * across guide/schema/docs and drifted out of sync). We deliberately do NOT
 * auto-generate the guides from the schema — the prose carries hazard
 * narrative (e.g. ipad-unlock's swipeOnKeyPressFailure HAZARD block) no
 * schema field holds, and collapsing that into generated text would lose it.
 * Instead: parse each guide's `## Parameters` markdown table and assert it
 * agrees with the tool's real JSON schema — every table row names a real
 * schema property (catches a renamed/removed param left stale in the docs,
 * e.g. click-at's now-removed `maxRetries`), and every schema property has a
 * table row (catches a new property added to the schema but never
 * documented, the dragPx-class drift). Type checking is intentionally loose
 * (presence/shape, not deep equality) since the same JSON Schema type has
 * multiple legitimate prose renderings (an enum as `"a" | "b"` vs `string`).
 */
import { describe, expect, it } from 'vitest';
import { toolGuidePrompts } from '../tool-guides.js';
import { toolRegistry } from '../../index.js';

interface ParamRow {
  name: string;
  type: string;
}

type ParamSection =
  | { kind: 'absent' } // no "## Parameters" heading at all — not checked (prose-only guide)
  | { kind: 'none' } // "## Parameters\nNone." — the tool takes no arguments
  | { kind: 'table'; rows: ParamRow[] };

function extractToolName(guideText: string): string | null {
  const m = /^# (pikvm_[a-z_]+)\b/m.exec(guideText);
  return m ? m[1] : null;
}

function extractParameterSection(guideText: string): ParamSection {
  // Some guides suffix the heading, e.g. "## Parameters (key ones)" — match
  // the heading line as a whole, not just the bare "## Parameters" form.
  const headingMatch = /^## Parameters.*\r?\n/m.exec(guideText);
  if (!headingMatch) return { kind: 'absent' };
  const startIdx = headingMatch.index + headingMatch[0].length;
  const rest = guideText.slice(startIdx);
  const endIdx = rest.search(/\n## /);
  const section = endIdx === -1 ? rest : rest.slice(0, endIdx);
  const firstLine = section.trim().split('\n')[0]?.trim() ?? '';
  if (/^None\.?$/.test(firstLine)) return { kind: 'none' };

  const rows: ParamRow[] = [];
  for (const line of section.split('\n')) {
    const cellMatch = /^\|(.+)\|\s*$/.exec(line.trim());
    if (!cellMatch) continue;
    // Markdown escapes a literal `|` inside a cell as `\|` (used for union-
    // literal types like `"click" \| "press"`) — split on unescaped pipes only.
    const cells = cellMatch[1].split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    if (cells.length < 2) continue;
    const name = cells[0].replace(/`/g, '');
    // Skip the header row and the markdown separator row (---|---|---).
    if (name === 'Parameter' || /^:?-+:?$/.test(cells[0])) continue;
    // Guard against unrelated tables reusing "## Parameters"-adjacent
    // formatting (e.g. a benchmark table) by requiring the name column to
    // look like an identifier (optionally combined, e.g. "assumeCursorAtX/Y").
    if (!/^[a-zA-Z][a-zA-Z0-9_/]*$/.test(name)) continue;
    rows.push({ name, type: cells[1] });
  }
  return { kind: 'table', rows };
}

/** Expand a combined row like "assumeCursorAtX/Y" into ["assumeCursorAtX", "assumeCursorAtY"].
 *  Single-property rows pass through unchanged. */
function expandCombinedNames(name: string): string[] {
  if (!name.includes('/')) return [name];
  const [first, ...rest] = name.split('/');
  return [first, ...rest.map((suffix) => first.slice(0, -suffix.length) + suffix)];
}

function schemaTypeMatches(schemaProp: Record<string, unknown>, tableType: string): boolean {
  const t = tableType.toLowerCase();
  const schemaType = schemaProp.type as string | undefined;
  const hasEnum = Array.isArray(schemaProp.enum);
  if (schemaType === 'array') return t.includes('[]') || t.includes('array');
  if (hasEnum) return t.includes('|') || t.includes('string'); // union-literal or bare-string rendering
  if (schemaType === 'string') return t.includes('string') || t.includes('|');
  if (schemaType === 'number') return t.includes('number');
  if (schemaType === 'boolean') return t.includes('boolean');
  if (schemaType === 'object') return t.includes('object');
  return true; // unrecognised schema shape — don't fail the type check on it
}

describe('tool-guide ↔ JSON-schema parameter consistency', () => {
  for (const guide of toolGuidePrompts) {
    const text = guide.getMessages()[0]?.content.text ?? '';
    const toolName = extractToolName(text);

    it(`${guide.name}: heading names a real registered tool`, () => {
      expect(toolName, `guide "${guide.name}" has no "# pikvm_..." heading`).not.toBeNull();
      const entry = toolRegistry.find((e) => e.name === toolName);
      expect(entry, `guide "${guide.name}" names unknown tool "${toolName}"`).toBeDefined();
    });

    if (!toolName) continue;
    const entry = toolRegistry.find((e) => e.name === toolName);
    if (!entry) continue;

    const section = extractParameterSection(text);
    const schemaProps = (entry.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
    const schemaKeys = Object.keys(schemaProps);

    if (section.kind === 'absent') continue; // prose-only guide, nothing to check
    if (section.kind === 'none') {
      it(`${toolName}: guide says "None" and the schema has no properties`, () => {
        expect(schemaKeys, `${toolName}'s guide says no params, but the schema has: ${schemaKeys.join(', ')}`).toHaveLength(0);
      });
      continue;
    }

    it(`${toolName}: every guide table row names a real schema property`, () => {
      const documentedNames = section.rows.flatMap((r) => expandCombinedNames(r.name));
      const stale = documentedNames.filter((name) => !schemaKeys.includes(name));
      expect(stale, `${toolName}'s guide documents propert(y/ies) not in the schema (removed/renamed?): ${stale.join(', ')}`).toEqual([]);
    });

    it(`${toolName}: every schema property is documented in the guide table`, () => {
      const documentedNames = new Set(section.rows.flatMap((r) => expandCombinedNames(r.name)));
      const missing = schemaKeys.filter((key) => !documentedNames.has(key));
      expect(missing, `${toolName}'s schema has propert(y/ies) missing from the guide's parameter table: ${missing.join(', ')}`).toEqual([]);
    });

    it(`${toolName}: documented types roughly agree with the schema`, () => {
      for (const row of section.rows) {
        for (const name of expandCombinedNames(row.name)) {
          const prop = schemaProps[name];
          if (!prop) continue; // already reported by the "real schema property" check above
          expect(
            schemaTypeMatches(prop, row.type),
            `${toolName}.${name}: guide says type "${row.type}", schema says ${JSON.stringify(prop.type ?? prop.enum)}`,
          ).toBe(true);
        }
      }
    });
  }
});
