/**
 * Tests for workflowPrompts — same structural contracts as the
 * tool-guide tests, plus argument-interpolation contracts unique
 * to workflows (which accept user input and embed it in the
 * generated guidance).
 */

import { describe, expect, it } from 'vitest';
import { workflowPrompts } from '../workflows.js';

describe('workflowPrompts structural contracts', () => {
  it('contains at least one workflow', () => {
    expect(workflowPrompts.length).toBeGreaterThan(0);
  });

  it('every workflow has a name and description', () => {
    for (const p of workflowPrompts) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it('every workflow name uses kebab-case', () => {
    const kebab = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    for (const p of workflowPrompts) {
      expect(p.name).toMatch(kebab);
    }
  });

  it('every workflow has a callable getMessages function returning a non-empty array', () => {
    for (const p of workflowPrompts) {
      expect(typeof p.getMessages).toBe('function');
      const messages = p.getMessages();
      expect(messages.length).toBeGreaterThan(0);
    }
  });

  it('every declared argument has a name and required flag', () => {
    for (const p of workflowPrompts) {
      if (!p.arguments) continue;
      for (const arg of p.arguments) {
        expect(typeof arg.name).toBe('string');
        expect(arg.name.length).toBeGreaterThan(0);
        expect(typeof arg.required).toBe('boolean');
      }
    }
  });

  it('all workflow names are unique', () => {
    const names = workflowPrompts.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('workflowPrompts argument interpolation', () => {
  it('click-ui-element-workflow embeds element_description into messages', () => {
    const p = workflowPrompts.find((w) => w.name === 'click-ui-element-workflow');
    expect(p).toBeDefined();
    const messages = p!.getMessages({ element_description: 'the Save button' });
    const allText = messages
      .map((m) => (m.content.type === 'text' ? m.content.text : ''))
      .join('\n');
    expect(allText).toContain('the Save button');
  });

  it('click-ui-element-workflow falls back to a placeholder when the arg is missing', () => {
    const p = workflowPrompts.find((w) => w.name === 'click-ui-element-workflow');
    expect(p).toBeDefined();
    const messages = p!.getMessages(); // no args
    const allText = messages
      .map((m) => (m.content.type === 'text' ? m.content.text : ''))
      .join('\n');
    // The implementation falls back to '[not specified]' when arg is missing —
    // assert it doesn't leak undefined / empty.
    expect(allText).not.toContain('undefined');
    expect(allText).toContain('[not specified]');
  });

  it('fill-form-workflow embeds form_description', () => {
    const p = workflowPrompts.find((w) => w.name === 'fill-form-workflow');
    expect(p).toBeDefined();
    const messages = p!.getMessages({ form_description: 'a contact form with name and email' });
    const allText = messages
      .map((m) => (m.content.type === 'text' ? m.content.text : ''))
      .join('\n');
    expect(allText).toContain('a contact form');
  });

  it('navigate-desktop-workflow embeds goal argument', () => {
    const p = workflowPrompts.find((w) => w.name === 'navigate-desktop-workflow');
    expect(p).toBeDefined();
    const messages = p!.getMessages({ goal: 'open Settings' });
    const allText = messages
      .map((m) => (m.content.type === 'text' ? m.content.text : ''))
      .join('\n');
    expect(allText).toContain('open Settings');
  });

  it('every workflow with declared arguments uses them in the generated message', () => {
    // For each workflow that declares an argument, generate messages with a
    // sentinel value and verify it appears somewhere in the output.
    // Catches the regression where a workflow declares an arg but forgets
    // to interpolate it (silently ignoring user input).
    for (const p of workflowPrompts) {
      if (!p.arguments || p.arguments.length === 0) continue;
      for (const arg of p.arguments) {
        const sentinel = `__SENTINEL_${arg.name}_VALUE__`;
        const messages = p.getMessages({ [arg.name]: sentinel });
        const allText = messages
          .map((m) => (m.content.type === 'text' ? m.content.text : ''))
          .join('\n');
        expect(allText).toContain(sentinel);
      }
    }
  });
});
