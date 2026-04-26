/**
 * Tests for the prompts barrel export — getPromptByName lookup
 * and the combined allPrompts array.
 */

import { describe, expect, it } from 'vitest';
import { allPrompts, getPromptByName } from '../index.js';
import { toolGuidePrompts } from '../tool-guides.js';
import { workflowPrompts } from '../workflows.js';

describe('allPrompts', () => {
  it('combines tool-guide and workflow prompts', () => {
    expect(allPrompts).toHaveLength(toolGuidePrompts.length + workflowPrompts.length);
  });

  it('preserves order: tool guides come before workflows', () => {
    // The first toolGuidePrompts.length entries must be tool-guides.
    for (let i = 0; i < toolGuidePrompts.length; i++) {
      expect(allPrompts[i].name).toBe(toolGuidePrompts[i].name);
    }
    // The remainder must be workflows.
    for (let i = 0; i < workflowPrompts.length; i++) {
      expect(allPrompts[toolGuidePrompts.length + i].name).toBe(workflowPrompts[i].name);
    }
  });

  it('all combined names are unique across both sources', () => {
    const names = allPrompts.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('getPromptByName', () => {
  it('returns undefined for an unknown prompt name', () => {
    expect(getPromptByName('this-prompt-does-not-exist')).toBeUndefined();
  });

  it('returns the matching prompt definition for a known name', () => {
    // 'take-screenshot' is one of the tool guides.
    const result = getPromptByName('take-screenshot');
    expect(result).toBeDefined();
    expect(result!.definition.name).toBe('take-screenshot');
  });

  it('returns the messages from getMessages() for the matched prompt', () => {
    const result = getPromptByName('take-screenshot');
    expect(result).toBeDefined();
    expect(Array.isArray(result!.messages)).toBe(true);
    expect(result!.messages.length).toBeGreaterThan(0);
    expect(result!.messages[0].role).toMatch(/user|assistant/);
  });

  it('passes the args object through to the prompt getMessages', () => {
    // Find a prompt that uses args (workflows often do).
    const argPrompt = allPrompts.find((p) => p.arguments && p.arguments.length > 0);
    if (!argPrompt) {
      // Skip if no prompt actually uses arguments in this codebase.
      return;
    }
    // Just verify the call doesn't throw with an args object.
    const result = getPromptByName(argPrompt.name, { someArg: 'value' });
    expect(result).toBeDefined();
  });

  it('lookup is exact-match (case sensitive — no leniency)', () => {
    expect(getPromptByName('Take-Screenshot')).toBeUndefined();
    expect(getPromptByName('TAKE-SCREENSHOT')).toBeUndefined();
    expect(getPromptByName('take-screenshot')).toBeDefined();
  });
});
