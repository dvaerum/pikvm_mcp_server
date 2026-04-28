/**
 * Anchors AGENTS.md tool-count claims against the actual code so
 * future drift fails a test instead of silently misleading new
 * contributors. The doc had previously claimed 8 tool-guides + 5
 * workflows when the code had grown to 14 + 6.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { toolGuidePrompts } from '../tool-guides.js';
import { workflowPrompts } from '../workflows.js';

function repoRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..', '..');
}

async function readAgentsMd(): Promise<string> {
  return fs.readFile(path.join(repoRoot(), 'AGENTS.md'), 'utf8');
}

async function readReadmeMd(): Promise<string> {
  return fs.readFile(path.join(repoRoot(), 'README.md'), 'utf8');
}

/**
 * Phase 171 (v0.5.161): count `pikvm_*` tool definitions in
 * src/index.ts dynamically rather than hardcoding the count in the
 * test. Phase 170 caught the manual hardcode (24 → 25 needed bump
 * after adding pikvm_dismiss_popup) — making this dynamic eliminates
 * the maintenance burden so future tool additions only need to bump
 * AGENTS.md, not also the test.
 *
 * The regex matches the pattern `name: 'pikvm_<name>'` inside the
 * tool array literal — same pattern the MCP server uses for every
 * tool definition.
 */
async function countPikvmTools(): Promise<number> {
  const indexPath = path.join(repoRoot(), 'src', 'index.ts');
  const src = await fs.readFile(indexPath, 'utf8');
  const matches = src.match(/^\s+name: 'pikvm_/gm) ?? [];
  return matches.length;
}

/**
 * Phase 173 (v0.5.163): extract all `pikvm_*` tool names from
 * src/index.ts. Used by name-coverage tests below to assert every
 * tool is mentioned in user-facing surfaces (AGENTS.md, README.md).
 */
async function listPikvmToolNames(): Promise<string[]> {
  const indexPath = path.join(repoRoot(), 'src', 'index.ts');
  const src = await fs.readFile(indexPath, 'utf8');
  const re = /^\s+name: '(pikvm_[a-z_]+)'/gm;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    names.push(m[1]);
  }
  return names;
}

/**
 * Phase 179 (v0.5.169): extract each `pikvm_*` tool's `name` and
 * its sibling `description: '...'`. Returns a list of {name,
 * description} so a regression test can assert every tool has a
 * non-empty description. Catches accidental truncations during
 * refactor.
 *
 * The regex is lenient (handles single quotes with escaped quotes,
 * the spread of typical tool descriptions). It anchors to the
 * specific pattern at top-of-tool-array-entry so multi-line nested
 * descriptions inside inputSchema are NOT matched.
 */
async function listPikvmToolNameDesc(): Promise<Array<{ name: string; description: string }>> {
  const indexPath = path.join(repoRoot(), 'src', 'index.ts');
  const src = await fs.readFile(indexPath, 'utf8');
  const lines = src.split('\n');
  const out: Array<{ name: string; description: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const nameMatch = /^\s+name: '(pikvm_[a-z_]+)',?$/.exec(lines[i]);
    if (!nameMatch) continue;
    // Description follows on the next line. Two layouts tolerated:
    //   description: 'single-line value'
    //   description:
    //     'multi-line concat ' +
    //     'value continues...',
    // Both cases: scan up to 3 lines after the name and grab the first
    // quoted string. We don't need the FULL description, just proof of
    // a non-trivial body.
    let description = '';
    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      const onLine = /['"`]([^'"`]+)['"`]/.exec(lines[j]);
      if (onLine) {
        description = onLine[1];
        break;
      }
    }
    out.push({ name: nameMatch[1], description });
  }
  return out;
}

describe('AGENTS.md freshness', () => {
  it('mentions the actual tool-guide count', async () => {
    const doc = await readAgentsMd();
    expect(doc).toContain(`${toolGuidePrompts.length} individual tool guide prompts`);
  });

  it('mentions the actual workflow count', async () => {
    const doc = await readAgentsMd();
    expect(doc).toContain(`${workflowPrompts.length} multi-step workflow prompts`);
  });

  it('Total tools count matches dynamic pikvm_* count + (toolGuides + workflows) skills', async () => {
    // Phase 171 (v0.5.161): count pikvm_* tools dynamically from
    // src/index.ts so adding a new tool only requires updating
    // AGENTS.md (not also this test). Phase 170 was the trigger:
    // adding pikvm_dismiss_popup needed manual bumps in two places.
    const doc = await readAgentsMd();
    const hardwareToolCount = await countPikvmTools();
    const expectedTotal = hardwareToolCount + toolGuidePrompts.length + workflowPrompts.length;
    expect(doc).toContain(`Total tools: ${expectedTotal}`);
  });

  it('Tool Guides table includes every tool-guide prompt name', async () => {
    const doc = await readAgentsMd();
    for (const p of toolGuidePrompts) {
      expect(doc).toContain(`\`${p.name}\``);
    }
  });

  it('Phase 173: every pikvm_* tool defined in src/index.ts is mentioned in AGENTS.md', async () => {
    // Catches "added a tool but forgot to document it" — exactly
    // the drift class Phase 169-170 caught manually for
    // pikvm_dismiss_popup. Future tools get the same guard.
    const doc = await readAgentsMd();
    const tools = await listPikvmToolNames();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(doc, `AGENTS.md should mention ${t}`).toContain(t);
    }
  });

  it('Phase 179: every pikvm_* tool has a non-empty single-line description', async () => {
    // Catches accidental description truncation during refactor.
    // The MCP protocol requires a non-empty description string for
    // each tool — clients use it to display tool purpose. An empty
    // description means the tool would surface to LLM agents with
    // no usage hint at all.
    const tools = await listPikvmToolNameDesc();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(
        t.description.length,
        `${t.name} must have a non-empty description`,
      ).toBeGreaterThan(20);
    }
  });

  it('Workflow Recipes table includes every workflow prompt name', async () => {
    const doc = await readAgentsMd();
    for (const p of workflowPrompts) {
      expect(doc).toContain(`\`${p.name}\``);
    }
  });
});

describe('docs/skills/ companion files', () => {
  it('every prompt has a matching docs/skills/<name>.md file', async () => {
    for (const p of [...toolGuidePrompts, ...workflowPrompts]) {
      const skillFile = path.join(repoRoot(), 'docs', 'skills', `${p.name}.md`);
      await expect(fs.access(skillFile)).resolves.toBeUndefined();
    }
  });

  it('every skill .md is non-empty', async () => {
    for (const p of [...toolGuidePrompts, ...workflowPrompts]) {
      const skillFile = path.join(repoRoot(), 'docs', 'skills', `${p.name}.md`);
      const content = await fs.readFile(skillFile, 'utf8');
      expect(content.trim().length).toBeGreaterThan(0);
    }
  });

  it('docs/skills/README.md lists every prompt', async () => {
    const readmePath = path.join(repoRoot(), 'docs', 'skills', 'README.md');
    const doc = await fs.readFile(readmePath, 'utf8');
    for (const p of [...toolGuidePrompts, ...workflowPrompts]) {
      expect(doc).toContain(`\`${p.name}\``);
    }
  });

  it('docs/skills/README.md links to every skill .md file', async () => {
    const readmePath = path.join(repoRoot(), 'docs', 'skills', 'README.md');
    const doc = await fs.readFile(readmePath, 'utf8');
    for (const p of [...toolGuidePrompts, ...workflowPrompts]) {
      // Markdown link like [name](name.md) — assert the .md filename appears.
      expect(doc).toContain(`${p.name}.md`);
    }
  });
});

describe('README.md freshness', () => {
  it('Skills table includes every tool-guide prompt name', async () => {
    const doc = await readReadmeMd();
    for (const p of toolGuidePrompts) {
      expect(doc).toContain(`\`${p.name}\``);
    }
  });

  it('Skills table includes every workflow prompt name', async () => {
    const doc = await readReadmeMd();
    for (const p of workflowPrompts) {
      expect(doc).toContain(`\`${p.name}\``);
    }
  });

  it('every prompt name has its skill_<snake_case> tool-name companion in README', async () => {
    const doc = await readReadmeMd();
    for (const p of [...toolGuidePrompts, ...workflowPrompts]) {
      const toolName = `skill_${p.name.replace(/-/g, '_')}`;
      expect(doc).toContain(toolName);
    }
  });

  it('Phase 173: every pikvm_* tool defined in src/index.ts is mentioned in README.md', async () => {
    // Companion guard to the AGENTS.md test above. README has its
    // own tool catalog at "### Keyboard / ### Mouse / etc." that
    // also needs to keep up with src/index.ts.
    const doc = await readReadmeMd();
    const tools = await listPikvmToolNames();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(doc, `README.md should mention ${t}`).toContain(t);
    }
  });
});
