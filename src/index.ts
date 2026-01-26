#!/usr/bin/env node
/**
 * PiKVM MCP Server
 *
 * Provides MCP tools for controlling remote machines via PiKVM.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { PiKVMClient } from './pikvm/client.js';
import { loadConfig } from './config.js';

// Defer initialization to main() for proper error handling
let pikvm: PiKVMClient;

// Define available tools
const tools: Tool[] = [
  {
    name: 'pikvm_screenshot',
    description: 'Capture a screenshot from the PiKVM video stream. Returns the current screen as a JPEG image.',
    inputSchema: {
      type: 'object',
      properties: {
        maxWidth: {
          type: 'number',
          description: 'Maximum width of the screenshot in pixels (optional, for preview)',
        },
        maxHeight: {
          type: 'number',
          description: 'Maximum height of the screenshot in pixels (optional, for preview)',
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 (optional, default 80)',
        },
      },
    },
  },
  {
    name: 'pikvm_get_resolution',
    description: 'Get the current screen resolution of the remote machine. Useful for knowing valid coordinate ranges for mouse operations.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_type',
    description: 'Type text on the remote machine using PiKVM. Handles special characters correctly via keymap conversion.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to type',
        },
        keymap: {
          type: 'string',
          description: 'Keyboard layout (default: en-us)',
        },
        slow: {
          type: 'boolean',
          description: 'Use slow typing mode for compatibility',
        },
        delay: {
          type: 'number',
          description: 'Delay between keystrokes in ms (0-200)',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'pikvm_key',
    description: 'Send a key or key combination to the remote machine. Use JavaScript key codes (e.g., KeyA, Enter, ControlLeft).',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key code (e.g., KeyA, Enter, Escape, F1)',
        },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifier keys to hold (e.g., ["ControlLeft", "AltLeft"])',
        },
        state: {
          type: 'string',
          enum: ['press', 'release', 'click'],
          description: 'Key state: press (hold), release, or click (press+release, default)',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'pikvm_shortcut',
    description: 'Send a keyboard shortcut (multiple keys pressed simultaneously). Example: Ctrl+Alt+Delete',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of key codes to press together (e.g., ["ControlLeft", "AltLeft", "Delete"])',
        },
      },
      required: ['keys'],
    },
  },
  {
    name: 'pikvm_mouse_move',
    description: 'Move the mouse cursor to a position on the remote machine. For absolute moves, coordinates are in screen pixels (0,0 = top-left). For relative moves, deltas are clamped to -127 to 127.',
    inputSchema: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: 'X coordinate in pixels (absolute) or delta pixels (relative)',
        },
        y: {
          type: 'number',
          description: 'Y coordinate in pixels (absolute) or delta pixels (relative)',
        },
        relative: {
          type: 'boolean',
          description: 'If true, move relative to current position (delta -127 to 127). Default: false (absolute pixel position)',
        },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'pikvm_mouse_click',
    description: 'Click a mouse button on the remote machine. Optionally move to a pixel position first.',
    inputSchema: {
      type: 'object',
      properties: {
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle', 'up', 'down'],
          description: 'Mouse button to click (default: left). "up" and "down" are scroll wheel buttons.',
        },
        x: {
          type: 'number',
          description: 'X pixel coordinate to move to before clicking (optional)',
        },
        y: {
          type: 'number',
          description: 'Y pixel coordinate to move to before clicking (optional)',
        },
        state: {
          type: 'string',
          enum: ['press', 'release', 'click'],
          description: 'Button state: press (hold), release, or click (default)',
        },
      },
    },
  },
  {
    name: 'pikvm_mouse_scroll',
    description: 'Scroll the mouse wheel on the remote machine.',
    inputSchema: {
      type: 'object',
      properties: {
        deltaX: {
          type: 'number',
          description: 'Horizontal scroll amount (negative = left, positive = right)',
        },
        deltaY: {
          type: 'number',
          description: 'Vertical scroll amount (negative = up, positive = down)',
        },
      },
      required: ['deltaY'],
    },
  },
];

// Create MCP server
const server = new Server(
  {
    name: 'pikvm-mcp-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'pikvm_screenshot': {
        const buffer = await pikvm.screenshot({
          maxWidth: args.maxWidth as number | undefined,
          maxHeight: args.maxHeight as number | undefined,
          quality: args.quality as number | undefined,
        });
        return {
          content: [
            {
              type: 'image',
              data: buffer.toString('base64'),
              mimeType: 'image/jpeg',
            },
          ],
        };
      }

      case 'pikvm_get_resolution': {
        const resolution = await pikvm.getResolution(true); // force refresh
        return {
          content: [
            {
              type: 'text',
              text: `Screen resolution: ${resolution.width}x${resolution.height} pixels. Valid mouse coordinates: x=0-${resolution.width - 1}, y=0-${resolution.height - 1}`,
            },
          ],
        };
      }

      case 'pikvm_type': {
        const text = args.text as string;
        if (!text) {
          throw new Error('text is required');
        }
        await pikvm.type(text, {
          keymap: args.keymap as string | undefined,
          slow: args.slow as boolean | undefined,
          delay: args.delay as number | undefined,
        });
        return {
          content: [{ type: 'text', text: `Typed: "${text}"` }],
        };
      }

      case 'pikvm_key': {
        const key = args.key as string;
        if (!key) {
          throw new Error('key is required');
        }
        const modifiers = (args.modifiers as string[] | undefined) || [];
        const state = args.state as 'press' | 'release' | 'click' | undefined;

        // Press modifiers
        for (const mod of modifiers) {
          await pikvm.sendKey(mod, { state: true });
        }

        // Send main key
        if (state === 'press') {
          await pikvm.sendKey(key, { state: true });
        } else if (state === 'release') {
          await pikvm.sendKey(key, { state: false });
        } else {
          await pikvm.sendKey(key); // click
        }

        // Release modifiers (in reverse order)
        for (const mod of [...modifiers].reverse()) {
          await pikvm.sendKey(mod, { state: false });
        }

        return {
          content: [
            {
              type: 'text',
              text: modifiers.length > 0
                ? `Sent key: ${modifiers.join('+')}+${key}`
                : `Sent key: ${key}`,
            },
          ],
        };
      }

      case 'pikvm_shortcut': {
        const keys = args.keys as string[];
        if (!keys || keys.length === 0) {
          throw new Error('keys array is required');
        }
        await pikvm.sendShortcut(keys);
        return {
          content: [{ type: 'text', text: `Sent shortcut: ${keys.join('+')}` }],
        };
      }

      case 'pikvm_mouse_move': {
        const x = args.x as number;
        const y = args.y as number;
        if (x === undefined || y === undefined) {
          throw new Error('x and y are required');
        }
        const relative = args.relative as boolean | undefined;
        if (relative) {
          await pikvm.mouseMoveRelative(x, y);
        } else {
          await pikvm.mouseMove(x, y);
        }
        return {
          content: [
            {
              type: 'text',
              text: relative
                ? `Moved mouse by (${x}, ${y})`
                : `Moved mouse to pixel (${x}, ${y})`,
            },
          ],
        };
      }

      case 'pikvm_mouse_click': {
        const button = (args.button as 'left' | 'right' | 'middle' | 'up' | 'down') || 'left';
        const clickX = args.x as number | undefined;
        const clickY = args.y as number | undefined;

        // Move to position first if specified
        if (clickX !== undefined && clickY !== undefined) {
          await pikvm.mouseMove(clickX, clickY);
        }

        const state = args.state as 'press' | 'release' | 'click' | undefined;
        if (state === 'press') {
          await pikvm.mouseClick(button, { state: true });
        } else if (state === 'release') {
          await pikvm.mouseClick(button, { state: false });
        } else {
          await pikvm.mouseClick(button);
        }

        return {
          content: [{ type: 'text', text: `${button} click` }],
        };
      }

      case 'pikvm_mouse_scroll': {
        const deltaY = args.deltaY as number;
        if (deltaY === undefined) {
          throw new Error('deltaY is required');
        }
        const deltaX = (args.deltaX as number) || 0;
        await pikvm.mouseScroll(deltaX, deltaY);
        return {
          content: [
            {
              type: 'text',
              text: `Scrolled (${deltaX}, ${deltaY})`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  // Load configuration (deferred to here for proper error handling)
  const config = loadConfig();
  pikvm = new PiKVMClient(config.pikvm);

  // Verify connection on startup
  const authOk = await pikvm.checkAuth();
  if (!authOk) {
    console.error('Warning: Could not authenticate with PiKVM. Check credentials.');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('PiKVM MCP Server running');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
