/**
 * Skill-doc loader — F11 (Round 2 Phase 2d): docs/skills/*.md is the
 * source of truth for every MCP prompt's served text (tool guides +
 * workflows). Before this, each prompt's guide text was maintained TWICE:
 * once as a template literal embedded in tool-guides.ts/workflows.ts (what
 * MCP clients actually received) and once as a human-readable mirror in
 * docs/skills/*.md — the two had already drifted (e.g. docs/skills/
 * take-screenshot.md documented a `keepCursorAlive` parameter the embedded
 * copy never mentioned). Loading directly from the doc at runtime makes
 * that drift structurally impossible: there is only one copy.
 *
 * RAW file content is served as-is — no stripping/reformatting layer
 * between "the doc" and "what's served" (a transformation layer could
 * itself go stale, reopening the exact problem this exists to close).
 *
 * Resolution mirrors cursor-ml-detect.ts's resolveVerifierModel: the
 * bundled path relative to THIS module (nix/package.nix copies
 * docs/skills/ into the install tree next to dist/, the same way it
 * bundles ml/crop-heatmap.onnx) is tried first, falling back to
 * `./docs/skills` under the cwd for a dev/source-tree run.
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function resolveSkillsDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url)); // dist/prompts or src/prompts
  const bundled = path.resolve(moduleDir, '..', '..', 'docs', 'skills');
  const cwdLocal = path.resolve(process.cwd(), 'docs', 'skills');
  return [bundled, cwdLocal].find((p) => existsSync(p)) ?? bundled;
}
const SKILLS_DIR = resolveSkillsDir();

const cache = new Map<string, string>();

/** Load docs/skills/<name>.md verbatim (cached after the first read — the
 *  server's process lifetime is what's cached against, not per-request). */
export function loadSkillDoc(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const filePath = path.join(SKILLS_DIR, `${name}.md`);
  const content = readFileSync(filePath, 'utf-8');
  cache.set(name, content);
  return content;
}

/**
 * Substitute `{{key}}` tokens in a loaded doc against a plain string map.
 * Deliberately dumb: the CALLER resolves whatever default/fallback a
 * missing argument should show (each parameterized workflow's fallback
 * text differs — e.g. fill-form-workflow falls back to "the visible form",
 * not a generic placeholder) and passes the already-resolved display
 * value in; this function only does the substitution. A token with no
 * matching key is left untouched rather than silently blanked, so a typo
 * in a doc's `{{...}}` marker fails loudly (visible in the served text)
 * instead of disappearing.
 */
export function interpolateSkillDoc(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}
