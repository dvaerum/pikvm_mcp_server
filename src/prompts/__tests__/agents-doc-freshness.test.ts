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

describe('AGENTS.md freshness', () => {
  it('mentions the actual tool-guide count', async () => {
    const doc = await readAgentsMd();
    expect(doc).toContain(`${toolGuidePrompts.length} individual tool guide prompts`);
  });

  it('mentions the actual workflow count', async () => {
    const doc = await readAgentsMd();
    expect(doc).toContain(`${workflowPrompts.length} multi-step workflow prompts`);
  });

  it('Total tools count matches 17 hardware + (toolGuides + workflows) skills', async () => {
    const doc = await readAgentsMd();
    const expectedTotal = 17 + toolGuidePrompts.length + workflowPrompts.length;
    expect(doc).toContain(`Total tools: ${expectedTotal}`);
  });

  it('Tool Guides table includes every tool-guide prompt name', async () => {
    const doc = await readAgentsMd();
    for (const p of toolGuidePrompts) {
      expect(doc).toContain(`\`${p.name}\``);
    }
  });

  it('Workflow Recipes table includes every workflow prompt name', async () => {
    const doc = await readAgentsMd();
    for (const p of workflowPrompts) {
      expect(doc).toContain(`\`${p.name}\``);
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
});
