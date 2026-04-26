/**
 * Structural tests for the toolGuidePrompts array. The MCP layer
 * exposes these prompts to clients; if a future addition has a
 * malformed shape (missing getMessages, duplicate name, empty
 * description), the prompt would silently fail at MCP-list time
 * with no clear failure signal here.
 */

import { describe, expect, it } from 'vitest';
import { toolGuidePrompts } from '../tool-guides.js';

describe('toolGuidePrompts structural contracts', () => {
  it('contains at least one prompt', () => {
    expect(toolGuidePrompts.length).toBeGreaterThan(0);
  });

  it('every prompt has a non-empty name', () => {
    for (const p of toolGuidePrompts) {
      expect(typeof p.name).toBe('string');
      expect(p.name.length).toBeGreaterThan(0);
    }
  });

  it('every prompt has a non-empty description', () => {
    for (const p of toolGuidePrompts) {
      expect(typeof p.description).toBe('string');
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it('all prompt names are unique (no duplicates would mask each other in MCP listing)', () => {
    const names = toolGuidePrompts.map((p) => p.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('every prompt has a callable getMessages function', () => {
    for (const p of toolGuidePrompts) {
      expect(typeof p.getMessages).toBe('function');
    }
  });

  it('getMessages returns a non-empty array on every prompt', () => {
    for (const p of toolGuidePrompts) {
      const messages = p.getMessages();
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBeGreaterThan(0);
    }
  });

  it('every message has a valid role and non-empty content', () => {
    for (const p of toolGuidePrompts) {
      const messages = p.getMessages();
      for (const m of messages) {
        expect(['user', 'assistant']).toContain(m.role);
        expect(m.content).toBeDefined();
        expect(m.content.type).toBe('text');
        if (m.content.type === 'text') {
          expect(typeof m.content.text).toBe('string');
          expect(m.content.text.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('every prompt name uses kebab-case (lowercase + hyphens, no spaces or underscores)', () => {
    const kebab = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    for (const p of toolGuidePrompts) {
      expect(p.name).toMatch(kebab);
    }
  });
});
