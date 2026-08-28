/**
 * Tool guide prompts — one per PiKVM tool that agents commonly use.
 *
 * F11 (Round 2 Phase 2d): served text loads directly from docs/skills/*.md
 * at runtime (see skill-docs.ts) — docs/skills/ is the source of truth,
 * not a separately-maintained embedded copy. See skill-docs.ts's header
 * for why (the two had already drifted before this change).
 */

import type { PromptDefinition } from './types.js';
import { loadSkillDoc } from './skill-docs.js';

export const toolGuidePrompts: PromptDefinition[] = [
  // ---------- take-screenshot ----------
  {
    name: 'take-screenshot',
    description: 'Guide for capturing screenshots with pikvm_screenshot',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('take-screenshot'),
          },
        },
      ];
    },
  },

  // ---------- check-resolution ----------
  {
    name: 'check-resolution',
    description: 'Guide for checking screen resolution with pikvm_get_resolution',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('check-resolution'),
          },
        },
      ];
    },
  },

  // ---------- type-text ----------
  {
    name: 'type-text',
    description: 'Guide for typing text with pikvm_type',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('type-text'),
          },
        },
      ];
    },
  },

  // ---------- send-key ----------
  {
    name: 'send-key',
    description: 'Guide for sending keys with pikvm_key',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('send-key'),
          },
        },
      ];
    },
  },

  // ---------- send-shortcut ----------
  {
    name: 'send-shortcut',
    description: 'Guide for sending keyboard shortcuts with pikvm_shortcut',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('send-shortcut'),
          },
        },
      ];
    },
  },

  // ---------- move-mouse ----------
  {
    name: 'move-mouse',
    description: 'Guide for moving the mouse with pikvm_mouse_move',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('move-mouse'),
          },
        },
      ];
    },
  },

  // ---------- click-element ----------
  {
    name: 'click-element',
    description: 'Guide for clicking with pikvm_mouse_click',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('click-element'),
          },
        },
      ];
    },
  },

  // ---------- auto-calibrate ----------
  {
    name: 'auto-calibrate',
    description: 'Guide for automatic mouse calibration with pikvm_auto_calibrate',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('auto-calibrate'),
          },
        },
      ];
    },
  },

  // ---------- scroll-page ----------
  {
    name: 'scroll-page',
    description: 'Guide for scrolling with pikvm_mouse_scroll',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('scroll-page'),
          },
        },
      ];
    },
  },

  // ---------- detect-orientation ----------
  {
    name: 'detect-orientation',
    description: 'Guide for pikvm_detect_orientation — find the iPad letterbox bounds within the HDMI capture',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('detect-orientation'),
          },
        },
      ];
    },
  },

  // ---------- ipad-unlock ----------
  {
    name: 'ipad-unlock',
    description: 'Guide for unlocking an iPad via pikvm_ipad_unlock',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('ipad-unlock'),
          },
        },
      ];
    },
  },

  // ---------- measure-ballistics ----------
  {
    name: 'measure-ballistics',
    description: 'Guide for characterizing relative-mouse ballistics with pikvm_measure_ballistics',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('measure-ballistics'),
          },
        },
      ];
    },
  },

  // ---------- move-to ----------
  {
    name: 'move-to',
    description: 'Guide for approximate move-to-pixel with pikvm_mouse_move_to',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('move-to'),
          },
        },
      ];
    },
  },

  // ---------- click-at ----------
  {
    name: 'click-at',
    description: 'Guide for click-at-coordinate with pikvm_mouse_click_at',
    getMessages() {
      return [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('click-at'),
          },
        },
      ];
    },
  },
];
