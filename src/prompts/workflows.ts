/**
 * Workflow prompts — multi-step recipes combining several PiKVM tools.
 *
 * F11 (Round 2 Phase 2d): served guide text loads directly from
 * docs/skills/*.md at runtime (see skill-docs.ts) — docs/skills/ is the
 * source of truth, not a separately-maintained embedded copy. The short
 * fixed "user" role message each workflow opens with stays inline here
 * (it's UI/protocol framing, not part of "the guide" — the docs/skills/
 * files never carried it). The 4 parameterized workflows' docs carry real
 * `{{placeholder}}` tokens now; interpolateSkillDoc substitutes them with
 * the SAME already-resolved display value (including each workflow's own
 * distinct fallback text) the pre-F11 inline template used.
 */

import type { PromptDefinition } from './types.js';
import { loadSkillDoc, interpolateSkillDoc } from './skill-docs.js';

export const workflowPrompts: PromptDefinition[] = [
  // ---------- setup-session-workflow ----------
  {
    name: 'setup-session-workflow',
    description: 'Step-by-step procedure for initializing a PiKVM session',
    getMessages() {
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'I need to start a new PiKVM session and make sure everything is working before I begin interacting with the remote machine.',
          },
        },
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('setup-session-workflow'),
          },
        },
      ];
    },
  },

  // ---------- calibrate-mouse-workflow ----------
  {
    name: 'calibrate-mouse-workflow',
    description: 'Step-by-step procedure for calibrating mouse coordinates',
    getMessages() {
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'I need to calibrate the mouse so that click coordinates are accurate.',
          },
        },
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('calibrate-mouse-workflow'),
          },
        },
      ];
    },
  },

  // ---------- auto-calibrate-mouse-workflow ----------
  {
    name: 'auto-calibrate-mouse-workflow',
    description: 'Step-by-step procedure for automatic mouse calibration',
    getMessages() {
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'I need to automatically calibrate the mouse for accurate clicking.',
          },
        },
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('auto-calibrate-mouse-workflow'),
          },
        },
      ];
    },
  },

  // ---------- click-ui-element-workflow ----------
  {
    name: 'click-ui-element-workflow',
    description: 'Step-by-step procedure for finding and clicking a UI element',
    arguments: [
      {
        name: 'element_description',
        description: 'Description of the UI element to click (e.g., "the Save button", "the File menu")',
        required: true,
      },
    ],
    getMessages(args) {
      const element = args?.element_description || '[not specified]';
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `I need to click on: ${element}`,
          },
        },
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: interpolateSkillDoc(loadSkillDoc('click-ui-element-workflow'), { element_description: element }),
          },
        },
      ];
    },
  },

  // ---------- fill-form-workflow ----------
  {
    name: 'fill-form-workflow',
    description: 'Step-by-step procedure for filling in a form on screen',
    arguments: [
      {
        name: 'form_description',
        description: 'Description of the form or the fields to fill in',
        required: false,
      },
    ],
    getMessages(args) {
      const form = args?.form_description || 'the visible form';
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `I need to fill in ${form}.`,
          },
        },
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: interpolateSkillDoc(loadSkillDoc('fill-form-workflow'), { form_description: form }),
          },
        },
      ];
    },
  },

  // ---------- ipad-keyboard-first-workflow ----------
  {
    name: 'ipad-keyboard-first-workflow',
    description: 'Keyboard-first iPad workflow that bypasses cursor positioning — e.g. launch apps via Spotlight (Cmd+Space → type app name → Enter). Prefer over pikvm_mouse_click_at whenever a keyboard equivalent exists; cursor clicks on tiny (<50px) iPad targets are unreliable due to pointer-acceleration variance.',
    arguments: [
      {
        name: 'goal',
        description: 'What you want to accomplish on the iPad (e.g., "open Settings and find Wi-Fi", "search Files for a document")',
        required: true,
      },
    ],
    getMessages(args) {
      const goal = args?.goal || '[not specified]';
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `iPad goal: ${goal}`,
          },
        },
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: interpolateSkillDoc(loadSkillDoc('ipad-keyboard-first-workflow'), { goal }),
          },
        },
      ];
    },
  },
  {
    name: 'navigate-desktop-workflow',
    description: 'Step-by-step procedure for navigating a desktop environment',
    arguments: [
      {
        name: 'goal',
        description: 'What you want to accomplish (e.g., "open Firefox", "find and open a file")',
        required: true,
      },
    ],
    getMessages(args) {
      const goal = args?.goal || '[not specified]';
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `I need to navigate the desktop to: ${goal}`,
          },
        },
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: interpolateSkillDoc(loadSkillDoc('navigate-desktop-workflow'), { goal }),
          },
        },
      ];
    },
  },
  {
    name: 'desktop-workflow',
    description:
      'Set up a generic desktop for reliable mouse control: --target desktop, auto-calibrate, ' +
      'absolute positioning (vs the iPad path)',
    arguments: [],
    getMessages() {
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'How do I reliably drive a normal desktop (not an iPad) through this PiKVM MCP server?',
          },
        },
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: loadSkillDoc('desktop-workflow'),
          },
        },
      ];
    },
  },
];
