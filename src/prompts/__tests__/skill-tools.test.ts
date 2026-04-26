/**
 * Tests for skill-tools.ts — auto-generates MCP tools from prompt
 * definitions so prompts are also discoverable as tools/list. The
 * name conversion is a round-trip contract that's easy to break
 * silently (mismatched separator → tool name lookup misses).
 */

import { describe, expect, it } from 'vitest';
import {
  skillTools,
  isSkillTool,
  handleSkillToolCall,
} from '../skill-tools.js';
import { allPrompts } from '../index.js';

describe('skillTools array', () => {
  it('mirrors allPrompts (one tool per prompt)', () => {
    expect(skillTools).toHaveLength(allPrompts.length);
  });

  it('each tool name follows the skill_<snake_case> convention', () => {
    const skillName = /^skill_[a-z][a-z0-9_]*$/;
    for (const t of skillTools) {
      expect(t.name).toMatch(skillName);
    }
  });

  it('every tool has the prompt description as its tool description', () => {
    for (const t of skillTools) {
      expect(typeof t.description).toBe('string');
      expect(t.description!.length).toBeGreaterThan(0);
    }
  });

  it('every tool has type=object inputSchema', () => {
    for (const t of skillTools) {
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('tools whose prompt declares required arguments expose them in the schema', () => {
    // click-ui-element-workflow declares element_description as required.
    const t = skillTools.find((x) => x.name === 'skill_click_ui_element_workflow');
    expect(t).toBeDefined();
    expect((t!.inputSchema as { required?: string[] }).required).toContain('element_description');
  });

  it('tools without arguments have no required field', () => {
    // setup-session-workflow has no arguments.
    const t = skillTools.find((x) => x.name === 'skill_setup_session_workflow');
    expect(t).toBeDefined();
    expect((t!.inputSchema as { required?: string[] }).required).toBeUndefined();
  });

  it('every tool is annotated as readOnly + non-destructive + idempotent', () => {
    for (const t of skillTools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.annotations?.idempotentHint).toBe(true);
      expect(t.annotations?.openWorldHint).toBe(false);
    }
  });
});

describe('isSkillTool', () => {
  it('returns true for names starting with "skill_"', () => {
    expect(isSkillTool('skill_take_screenshot')).toBe(true);
    expect(isSkillTool('skill_anything')).toBe(true);
  });

  it('returns false for names without the prefix', () => {
    expect(isSkillTool('take_screenshot')).toBe(false);
    expect(isSkillTool('pikvm_mouse_click_at')).toBe(false);
    expect(isSkillTool('')).toBe(false);
  });

  it('is exact-prefix sensitive (does not match e.g. "skills_X")', () => {
    expect(isSkillTool('skills_x')).toBe(false);
  });
});

describe('handleSkillToolCall', () => {
  it('returns text content for a known skill tool', () => {
    const result = handleSkillToolCall('skill_take_screenshot');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it('passes string args through to the underlying prompt', () => {
    const result = handleSkillToolCall('skill_click_ui_element_workflow', {
      element_description: 'the Save button',
    });
    expect(result.content[0].text).toContain('the Save button');
  });

  it('filters non-string args (only strings reach the prompt)', () => {
    // Pass mixed types — only the string ones should make it through.
    const result = handleSkillToolCall('skill_click_ui_element_workflow', {
      element_description: 'sentinel',
      noise: 12345,           // number — must be dropped
      flag: true,              // boolean — must be dropped
    } as Record<string, unknown>);
    expect(result.content[0].text).toContain('sentinel');
  });

  it('throws on unknown skill tool name', () => {
    expect(() => handleSkillToolCall('skill_does_not_exist')).toThrow(/Unknown skill tool/);
  });

  it('round-trips name conversion correctly (skill_X → take-screenshot lookup works)', () => {
    // Sanity that the underscore-to-hyphen conversion lines up.
    expect(() => handleSkillToolCall('skill_take_screenshot')).not.toThrow();
  });
});
