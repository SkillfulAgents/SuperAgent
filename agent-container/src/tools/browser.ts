/**
 * Browser Automation Tools
 *
 * These tools allow agents to control a headless browser via agent-browser.
 * Each tool calls the container's own HTTP browser endpoints internally.
 * The user can see the browser live and interact with it directly.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const CONTAINER_URL = `http://localhost:${process.env.PORT || '3000'}`

// Helper to get the current session ID from the environment
// The session ID is set by the MCP server context when tools are invoked
let currentSessionId: string | null = null

export function setCurrentBrowserSessionId(sessionId: string | null): void {
  currentSessionId = sessionId
}

async function browserFetch(
  endpoint: string,
  body: Record<string, unknown>
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const response = await fetch(`${CONTAINER_URL}/browser/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId, ...body }),
    })
    const data = await response.json() as Record<string, unknown>
    if (!response.ok) {
      return { success: false, error: (data.error as string) || `HTTP ${response.status}` }
    }
    return { success: true, data }
  } catch (error: any) {
    return { success: false, error: error.message || 'Request failed' }
  }
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  }
}

export const browserOpenTool = tool(
  'browser_open',
  `Open a headless browser and navigate to a URL. The user can see the browser live in their interface and interact with it directly.

Use this to start browsing a website. The browser preserves cookies/sessions via a persistent profile, so the user only needs to log in once.`,
  {
    url: z.string().describe('The URL to navigate to'),
  },
  async (args) => {
    const result = await browserFetch('open', { url: args.url })
    if (!result.success) return errorResult(result.error!)
    return {
      content: [
        {
          type: 'text' as const,
          text: `Browser opened and navigating to ${args.url}. The user can see the browser live. Use browser_snapshot to see the page content.`,
        },
      ],
    }
  }
)

export const browserCloseTool = tool(
  'browser_close',
  `Close the browser and free resources. Call this when you're done browsing.`,
  {},
  async () => {
    const result = await browserFetch('close', {})
    if (!result.success) return errorResult(result.error!)
    return {
      content: [
        { type: 'text' as const, text: 'Browser closed.' },
      ],
    }
  }
)

export const browserSnapshotTool = tool(
  'browser_snapshot',
  `Get an accessibility tree snapshot of the current page. Returns interactive elements with refs (like @e1, @e2) that you can use with browser_click and browser_fill.

Use interactive=true (default) to get clickable/fillable elements with refs.
Use compact=true (default) to reduce output size.`,
  {
    interactive: z
      .boolean()
      .optional()
      .default(true)
      .describe('Include interactive elements with refs (default: true)'),
    compact: z
      .boolean()
      .optional()
      .default(true)
      .describe('Compact output to reduce size (default: true)'),
  },
  async (args) => {
    const result = await browserFetch('snapshot', {
      interactive: args.interactive,
      compact: args.compact,
    })
    if (!result.success) return errorResult(result.error!)

    const data = result.data as Record<string, unknown>
    const text = data.snapshot
      ? String(data.snapshot)
      : JSON.stringify(data, null, 2)

    return {
      content: [{ type: 'text' as const, text }],
    }
  }
)

export const browserClickTool = tool(
  'browser_click',
  `Click an element on the page by its ref (e.g., @e1). Get refs from browser_snapshot.`,
  {
    ref: z.string().describe('Element ref from snapshot (e.g., "@e1")'),
  },
  async (args) => {
    const result = await browserFetch('click', { ref: args.ref })
    if (!result.success) return errorResult(result.error!)
    return {
      content: [
        {
          type: 'text' as const,
          text: `Clicked ${args.ref}. Use browser_snapshot to see the updated page.`,
        },
      ],
    }
  }
)

export const browserFillTool = tool(
  'browser_fill',
  `Fill an input field by its ref (e.g., @e2) with a value. Get refs from browser_snapshot.`,
  {
    ref: z.string().describe('Input element ref from snapshot (e.g., "@e2")'),
    value: z.string().describe('The text to fill into the input'),
  },
  async (args) => {
    const result = await browserFetch('fill', {
      ref: args.ref,
      value: args.value,
    })
    if (!result.success) return errorResult(result.error!)
    return {
      content: [
        {
          type: 'text' as const,
          text: `Filled ${args.ref} with "${args.value}".`,
        },
      ],
    }
  }
)

export const browserScrollTool = tool(
  'browser_scroll',
  `Scroll the page in a given direction.`,
  {
    direction: z
      .enum(['up', 'down', 'left', 'right'])
      .describe('Scroll direction'),
    amount: z
      .number()
      .optional()
      .describe('Scroll amount in pixels (default: browser default)'),
  },
  async (args) => {
    const result = await browserFetch('scroll', {
      direction: args.direction,
      amount: args.amount,
    })
    if (!result.success) return errorResult(result.error!)
    return {
      content: [
        {
          type: 'text' as const,
          text: `Scrolled ${args.direction}${args.amount ? ` by ${args.amount}px` : ''}.`,
        },
      ],
    }
  }
)

export const browserWaitTool = tool(
  'browser_wait',
  `Wait for a condition before continuing. Use "networkidle" after navigation to ensure the page is fully loaded.`,
  {
    for: z
      .string()
      .describe(
        'Condition to wait for: "networkidle", "load", "domcontentloaded", or a CSS selector'
      ),
  },
  async (args) => {
    const result = await browserFetch('wait', { for: args.for })
    if (!result.success) return errorResult(result.error!)
    return {
      content: [
        { type: 'text' as const, text: `Wait condition "${args.for}" satisfied.` },
      ],
    }
  }
)

export const browserPressTool = tool(
  'browser_press',
  `Press a keyboard key. Use this for Enter (submit forms), Tab (next field), Escape (close dialogs), or key combos like "Control+a".`,
  {
    key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Escape", "Control+a", "ArrowDown")'),
  },
  async (args) => {
    const result = await browserFetch('press', { key: args.key })
    if (!result.success) return errorResult(result.error!)
    return {
      content: [
        { type: 'text' as const, text: `Pressed "${args.key}".` },
      ],
    }
  }
)

export const browserScreenshotTool = tool(
  'browser_screenshot',
  `Take a screenshot of the current page. Returns the file path of the saved screenshot. You can then read the file to see the image. Use full=true to capture the entire scrollable page.`,
  {
    full: z
      .boolean()
      .optional()
      .default(false)
      .describe('Capture full scrollable page (default: false, viewport only)'),
  },
  async (args) => {
    const result = await browserFetch('screenshot', { full: args.full })
    if (!result.success) return errorResult(result.error!)
    const data = result.data as Record<string, unknown>
    const output = data.output ? String(data.output) : 'Screenshot taken.'
    return {
      content: [
        { type: 'text' as const, text: output },
      ],
    }
  }
)

export const browserSelectTool = tool(
  'browser_select',
  `Select an option from a <select> dropdown element by its ref. Get refs from browser_snapshot.`,
  {
    ref: z.string().describe('Select element ref from snapshot (e.g., "@e3")'),
    value: z.string().describe('The option value to select'),
  },
  async (args) => {
    const result = await browserFetch('select', { ref: args.ref, value: args.value })
    if (!result.success) return errorResult(result.error!)
    return {
      content: [
        { type: 'text' as const, text: `Selected "${args.value}" in ${args.ref}.` },
      ],
    }
  }
)

export const browserHoverTool = tool(
  'browser_hover',
  `Hover over an element by its ref. Useful for triggering dropdown menus, tooltips, or hover states. Get refs from browser_snapshot.`,
  {
    ref: z.string().describe('Element ref from snapshot (e.g., "@e1")'),
  },
  async (args) => {
    const result = await browserFetch('hover', { ref: args.ref })
    if (!result.success) return errorResult(result.error!)
    return {
      content: [
        { type: 'text' as const, text: `Hovered over ${args.ref}. Use browser_snapshot to see any changes.` },
      ],
    }
  }
)

export const browserRunTool = tool(
  'browser_run',
  `Run any agent-browser CLI command. Use this for advanced browser operations not covered by the dedicated tools.

Pass the command string WITHOUT the "agent-browser" prefix.

Available commands:
- dblclick <ref> — Double-click element
- focus <ref> — Focus element
- type <ref> <text> — Type text (appends, unlike fill which clears first)
- keydown/keyup <key> — Hold/release key
- check/uncheck <ref> — Toggle checkbox
- scrollintoview <ref> — Scroll element into view
- drag <srcRef> <tgtRef> — Drag and drop
- upload <ref> <files> — Upload files
- eval <js> — Run JavaScript
- get text/html/value/attr/title/url/count/box <ref> — Get element info
- is visible/enabled/checked <ref> — Check element state
- find role/text/label/placeholder/alt/title/testid <query> <action> — Semantic locators
- back / forward / reload — Navigation
- tab / tab new / tab <n> / tab close — Tab management
- frame <sel> / frame main — Switch frames
- dialog accept/dismiss — Handle dialogs
- set viewport/device/geo/offline/headers/media — Browser settings
- cookies / cookies set/clear — Cookie management
- storage local/session [get/set/clear] — Storage management
- mouse move/down/up/wheel — Low-level mouse control
- network route/unroute/requests — Network interception
- console / errors — Debug info
- wait <selector|ms|--text|--url|--load|--fn> — Wait for conditions`,
  {
    command: z.string().describe('The agent-browser command to run (without "agent-browser" prefix)'),
  },
  async (args) => {
    const result = await browserFetch('run', { command: args.command })
    if (!result.success) return errorResult(result.error!)
    const data = result.data as Record<string, unknown>
    const output = data.output ? String(data.output) : 'Command executed.'
    return {
      content: [
        { type: 'text' as const, text: output },
      ],
    }
  }
)

export const browserTools = [
  browserOpenTool,
  browserCloseTool,
  browserSnapshotTool,
  browserClickTool,
  browserFillTool,
  browserScrollTool,
  browserWaitTool,
  browserPressTool,
  browserScreenshotTool,
  browserSelectTool,
  browserHoverTool,
  browserRunTool,
]
