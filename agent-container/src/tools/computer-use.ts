/**
 * Computer Use Tools
 *
 * MCP tools that allow agents to control the host computer via @skillful-agents/agent-computer.
 * Each tool call blocks via InputManager until the host approves and executes it.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { resizeBase64Screenshot } from '../image-utils'
import { inputManager } from '../input-manager'

/**
 * Shared helper: creates a pending input request that blocks until the host
 * resolves (executes) or rejects (denies) the computer use command.
 */
async function computerUseRequest(
  method: string,
  params: Record<string, unknown>,
  permissionLevel: 'list_apps_windows' | 'use_application' | 'use_host_shell',
  appName?: string,
) {
  const toolUseId = inputManager.consumeCurrentToolUseId()

  if (!toolUseId) {
    console.error(`[computer_use:${method}] No toolUseId available`)
    return {
      content: [{ type: 'text' as const, text: 'Unable to process computer use request - no tool use ID available.' }],
      isError: true,
    }
  }

  try {
    const output = await inputManager.createPendingWithType<string>(toolUseId, 'computer_use', {
      method,
      params,
      permissionLevel,
      appName,
    })

    // For screenshots, parse the result and return as an MCP image content block
    if (method === 'screenshot' && output) {
      try {
        const parsed = JSON.parse(output)
        if (parsed.type === 'screenshot' && parsed.base64) {
          const mediaMime = (parsed.media_type || 'image/png') as string
          const resized = await resizeBase64Screenshot(parsed.base64, mediaMime)
          const origW = parsed.width
          const origH = parsed.height
          const content: Array<{ type: 'image'; data: string; mimeType: `image/${string}` } | { type: 'text'; text: string }> = [
            {
              type: 'image' as const,
              data: resized.base64,
              mimeType: resized.mimeType as `image/${string}`,
            },
          ]
          if (resized.resized && origW && origH) {
            content.push({
              type: 'text' as const,
              text: `Note: This screenshot was resized for the API. The actual screen resolution is ${origW}x${origH}. If using clickAt with x/y coordinates, use the original resolution coordinates, not the image pixel positions.`,
            })
          }
          return { content }
        }
      } catch {
        // Fall through to text response
      }
    }

    return {
      content: [{ type: 'text' as const, text: output || `${method} completed successfully.` }],
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.log(`[computer_use:${method}] Request failed: ${errorMessage}`)

    return {
      content: [{ type: 'text' as const, text: `Computer use request failed: ${errorMessage}` }],
      isError: true,
    }
  }
}

// =============================================================================
// Observation tools
// =============================================================================

export const computerAppsTool = tool(
  'computer_apps',
  'List all running applications on the host computer. Returns app names, bundle IDs, and process IDs.',
  {},
  async () => computerUseRequest('apps', {}, 'list_apps_windows'),
)

export const computerWindowsTool = tool(
  'computer_windows',
  'List all open windows on the host computer. Each window gets a ref like @w1 that can be used with computer_grab. Optionally filter by app name.',
  {
    app: z.string().optional().describe('Filter windows by application name'),
  },
  async (args) => computerUseRequest('windows', { app: args.app }, 'list_apps_windows'),
)

export const computerSnapshotTool = tool(
  'computer_snapshot',
  `Take an accessibility tree snapshot of the currently grabbed application window. Returns interactive elements with typed refs (@b1 for buttons, @t1 for text fields, etc.) that can be used with click, fill, and other interaction tools.

Use --interactive to show only actionable elements (buttons, fields, links). Use --compact for a flat list format.

IMPORTANT: You must grab a window first with computer_grab before taking a snapshot, unless you specify an app name.`,
  {
    app: z.string().optional().describe('Target a specific app instead of the grabbed window'),
    interactive: z.boolean().optional().describe('Only show interactive elements (buttons, fields, links)'),
    compact: z.boolean().optional().describe('Use compact flat list format'),
  },
  async (args) => computerUseRequest('snapshot', {
    app: args.app,
    interactive: args.interactive,
    compact: args.compact,
  }, 'use_application', args.app),
)

export const computerFindTool = tool(
  'computer_find',
  'Find elements by text content or role in the currently grabbed application. Returns matching elements with their refs.',
  {
    text: z.string().describe('Text to search for in element labels and values'),
    role: z.string().optional().describe('Filter by role (button, textfield, link, checkbox, etc.)'),
    app: z.string().optional().describe('Target a specific app instead of the grabbed window'),
  },
  async (args) => computerUseRequest('find', {
    text: args.text,
    role: args.role,
    app: args.app,
  }, 'use_application', args.app),
)

export const computerScreenshotTool = tool(
  'computer_screenshot',
  'Take a screenshot of the currently grabbed window or the entire screen. Returns the image data.',
  {
    ref: z.string().optional().describe('Element ref to screenshot (captures that element\'s bounds)'),
  },
  async (args) => computerUseRequest('screenshot', { ref: args.ref }, 'use_application'),
)

// =============================================================================
// Interaction tools
// =============================================================================

export const computerClickTool = tool(
  'computer_click',
  'Click an element by its ref (e.g. @b1, @l2). The ref comes from a previous snapshot or find command. Supports right-click and double-click.',
  {
    ref: z.string().describe('Element ref to click (e.g. @b1, @l2, @t1)'),
    right: z.boolean().optional().describe('Right-click instead of left-click'),
    double: z.boolean().optional().describe('Double-click'),
  },
  async (args) => computerUseRequest('click', {
    ref: args.ref,
    right: args.right,
    double: args.double,
  }, 'use_application'),
)

export const computerTypeTool = tool(
  'computer_type',
  'Type text into the currently focused element. Use computer_fill instead if you want to clear and replace the contents of a specific field.',
  {
    text: z.string().describe('Text to type'),
  },
  async (args) => computerUseRequest('type', { text: args.text }, 'use_application'),
)

export const computerFillTool = tool(
  'computer_fill',
  'Focus a text field by ref, clear its contents, and fill it with new text. This is an atomic operation — use this instead of click + select-all + type.',
  {
    ref: z.string().describe('Text field ref to fill (e.g. @t1)'),
    text: z.string().describe('Text to fill into the field'),
  },
  async (args) => computerUseRequest('fill', { ref: args.ref, text: args.text }, 'use_application'),
)

export const computerKeyTool = tool(
  'computer_key',
  'Press a key or key combination. Examples: "enter", "tab", "cmd+a", "cmd+c", "cmd+v", "shift+tab", "escape", "space", "backspace", "cmd+shift+z".',
  {
    combo: z.string().describe('Key combination to press (e.g. "cmd+a", "enter", "shift+tab")'),
    repeat: z.number().optional().describe('Number of times to repeat the key press'),
  },
  async (args) => computerUseRequest('key', { combo: args.combo, repeat: args.repeat }, 'use_application'),
)

export const computerScrollTool = tool(
  'computer_scroll',
  'Scroll in a direction. Can scroll within a specific element by ref.',
  {
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
    amount: z.number().optional().describe('Number of scroll ticks (default: 3)'),
    on: z.string().optional().describe('Element ref to scroll within (e.g. @sa1 for a scroll area)'),
  },
  async (args) => computerUseRequest('scroll', {
    direction: args.direction,
    amount: args.amount,
    on: args.on,
  }, 'use_application'),
)

export const computerSelectTool = tool(
  'computer_select',
  'Select a value from a dropdown/popup menu element.',
  {
    ref: z.string().describe('Dropdown element ref (e.g. @d1)'),
    value: z.string().describe('Value to select'),
  },
  async (args) => computerUseRequest('select', { ref: args.ref, value: args.value }, 'use_application'),
)

// =============================================================================
// App & window management
// =============================================================================

export const computerLaunchTool = tool(
  'computer_launch',
  'Launch an application by name. Waits for the app to be ready and automatically grabs it (locks onto it for subsequent commands and shows a visual halo to the user). Use computer_ungrab when done.',
  {
    name: z.string().describe('Application name (e.g. "Calculator", "Safari", "TextEdit")'),
  },
  async (args) => computerUseRequest('launch', { name: args.name }, 'use_application', args.name),
)

export const computerQuitTool = tool(
  'computer_quit',
  'Quit an application by name.',
  {
    name: z.string().describe('Application name to quit'),
    force: z.boolean().optional().describe('Force quit the application'),
  },
  async (args) => computerUseRequest('quit', { name: args.name, force: args.force }, 'use_application', args.name),
)

export const computerGrabTool = tool(
  'computer_grab',
  'Lock onto a specific window or app for subsequent commands. After grabbing, snapshot/click/type/etc. will target this window. Use computer_windows to list available windows first.',
  {
    app: z.string().optional().describe('Grab by application name (grabs first window)'),
    ref: z.string().optional().describe('Grab by window ref (e.g. @w1 from computer_windows)'),
  },
  async (args) => {
    if (!args.app && !args.ref) {
      return {
        content: [{ type: 'text' as const, text: 'Error: Either app or ref must be provided.' }],
        isError: true,
      }
    }
    return computerUseRequest('grab', { app: args.app, ref: args.ref }, 'use_application', args.app)
  },
)

export const computerUngrabTool = tool(
  'computer_ungrab',
  'Release the currently grabbed window. After ungrabbing, you must grab a new window before using interaction tools.',
  {},
  async () => computerUseRequest('ungrab', {}, 'use_application'),
)

// =============================================================================
// Menu & dialog tools
// =============================================================================

export const computerMenuTool = tool(
  'computer_menu',
  'Click a menu item by its path. Use ">" to separate menu levels. Example: "File > Save", "Edit > Find > Find..."',
  {
    path: z.string().describe('Menu path using ">" separators (e.g. "File > Save As...")'),
    app: z.string().optional().describe('Target a specific app'),
  },
  async (args) => computerUseRequest('menuClick', { path: args.path, app: args.app }, 'use_application', args.app),
)

export const computerDialogTool = tool(
  'computer_dialog',
  'Detect or handle system dialogs and alerts. Use "detect" to check if a dialog is present, "accept" to click OK/Save, "cancel" to dismiss.',
  {
    action: z.enum(['detect', 'accept', 'cancel']).describe('Action: detect (check for dialog), accept (click OK), cancel (dismiss)'),
    app: z.string().optional().describe('Target a specific app'),
  },
  async (args) => computerUseRequest('dialog', { action: args.action, app: args.app }, 'use_application', args.app),
)

// =============================================================================
// Generic escape hatch
// =============================================================================

export const computerRunTool = tool(
  'computer_run',
  `Run an arbitrary agent-computer (ac) command. Use this for advanced operations not covered by the specific tools above. The command is the ac method name and args is a JSON object of parameters.

Examples:
- method: "read", args: { ref: "@t1" } — read an element's value
- method: "hover", args: { ref: "@b1" } — hover over an element
- method: "drag", args: { from: "@b1", to: "@b2" } — drag between elements
- method: "wait", args: { ms: 2000 } — wait 2 seconds
- method: "clipboard", args: {} — read clipboard contents`,
  {
    command: z.string().describe('The ac method name to execute'),
    args: z.record(z.string(), z.unknown()).optional().describe('Arguments to pass to the method'),
  },
  async (toolArgs) => computerUseRequest(
    toolArgs.command,
    toolArgs.args || {},
    'use_application',
  ),
)

// =============================================================================
// Export all tools as an array
// =============================================================================

export const computerUseTools = [
  computerAppsTool,
  computerWindowsTool,
  computerSnapshotTool,
  computerFindTool,
  computerScreenshotTool,
  computerClickTool,
  computerTypeTool,
  computerFillTool,
  computerKeyTool,
  computerScrollTool,
  computerSelectTool,
  computerLaunchTool,
  computerQuitTool,
  computerGrabTool,
  computerUngrabTool,
  computerMenuTool,
  computerDialogTool,
  computerRunTool,
]
