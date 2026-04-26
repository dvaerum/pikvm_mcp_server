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

  it('Total tools count matches 24 hardware + (toolGuides + workflows) skills', async () => {
    const doc = await readAgentsMd();
    // 24 hardware tools as of v0.5.64. Counted from src/index.ts:
    // pikvm_version, pikvm_health_check, pikvm_screenshot,
    // pikvm_get_resolution, pikvm_type, pikvm_key, pikvm_shortcut,
    // pikvm_mouse_move, pikvm_mouse_click, pikvm_mouse_scroll,
    // pikvm_calibrate, pikvm_set_calibration, pikvm_get_calibration,
    // pikvm_clear_calibration, pikvm_ipad_unlock, pikvm_detect_orientation,
    // pikvm_ipad_home, pikvm_ipad_app_switcher, pikvm_ipad_launch_app,
    // pikvm_mouse_move_to, pikvm_mouse_click_at, pikvm_measure_ballistics,
    // pikvm_auto_calibrate, pikvm_seed_cursor_template.
    const expectedTotal = 24 + toolGuidePrompts.length + workflowPrompts.length;
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
});
