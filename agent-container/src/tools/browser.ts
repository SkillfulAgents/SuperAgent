/**
 * Browser Automation Tools
 *
 * These tools allow agents to control a headless browser via agent-browser.
 * Each tool calls the container's own HTTP browser endpoints internally.
 * The user can see the browser live and interact with it directly.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { readFile } from 'fs/promises'
import { z } from 'zod'
import { resizeScreenshot } from '../image-utils'
import { hostAuthHeaders } from '../host-auth'
import { tabManager } from '../tab-manager'
import { formatUrlDigest, formatUrlDigestBrief, formatFillReadback, formatScrollDigest, type UrlDigest, type ScrollInfo } from '../browser-digest'

const CONTAINER_URL = `http://localhost:${process.env.PORT || '3000'}`

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  }
}

/** Get tab warning from cached tab count (no network call needed — same process) */
function getTabWarning(): string {
  return tabManager.formatTabWarning(tabManager.getTabCount())
}

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

export function extractScreenshotPath(output: string): string {
  const clean = stripAnsi(output).trim()
  // Extract file path - look for an absolute path ending with .png or .jpg/.jpeg
  const match = clean.match(/(\/\S+\.(?:png|jpe?g))/i)
  return match ? match[1] : clean
}

async function readScreenshotAsBase64(filePath: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const buffer = await readFile(filePath.trim())
    const mimeType = filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')
      ? 'image/jpeg'
      : 'image/png'
    const resized = await resizeScreenshot(buffer, mimeType)
    return { data: resized.data.toString('base64'), mimeType: resized.mimeType }
  } catch {
    return null
  }
}

/**
 * Build the browser tool set for one session/process.
 *
 * `getSessionId` is read at call time on every request: a ClaudeCodeProcess's
 * session id changes whenever its SDK query (re)starts, and a module-global id
 * shared across processes is exactly the race that stranded browser sub-agents
 * in "Browser is owned by session <other>" loops (see browser-tools-audit.md).
 */
export function createBrowserTools(getSessionId: () => string | null) {
  async function browserFetch(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    try {
      // In-process self-call to our own server: needs the host token now that
      // the API rejects unauthenticated callers.
      const response = await fetch(`${CONTAINER_URL}/browser/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...hostAuthHeaders() },
        body: JSON.stringify({ sessionId: getSessionId(), ...body }),
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

  const browserOpenTool = tool(
  'browser_open',
  `Open a headless browser and navigate to a URL. The user can see the browser live in their interface and interact with it directly.

Use this to start browsing a website. The browser preserves cookies/sessions via a persistent profile, so the user only needs to log in once.`,
  {
    url: z.string().describe('The URL to navigate to'),
  },
  async (args) => {
    // Warn if the agent is trying to open a localhost URL — the browser runs outside
    // the container and cannot reach servers running inside it (e.g. dashboards).
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(args.url)
    const localhostWarning = isLocalhost
      ? '\n\nWARNING: This is a localhost URL. The browser runs outside the container and cannot access servers running inside it. If you are trying to view a dashboard, stop — the user can already see dashboards through the Gamut UI. Use get_dashboard_logs to debug any issues instead.'
      : ''

    const result = await browserFetch('open', { url: args.url })
    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${result.error}${localhostWarning}` }],
        isError: true,
      }
    }
    const data = result.data as Record<string, unknown> | undefined

    if (data?.switchedToExisting) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Switched to existing tab ${data.tabId} which already has ${data.url} open. Use browser_snapshot to see the page content.${localhostWarning}`,
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Browser opened and navigating to ${args.url}. The user can see the browser live. Use browser_snapshot to see the page content.${localhostWarning}`,
        },
      ],
    }
  }
)

const browserCloseTool = tool(
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

const browserSnapshotTool = tool(
  'browser_snapshot',
  `Get an accessibility tree snapshot of the current page. Returns interactive elements with refs (like @e1, @e2) that you can use with browser_click and browser_fill.

The default view shows interactive elements only. Two knobs handle the cases that view misses:
- scope: limit the snapshot to a CSS-selected region (e.g. "form", "#main", ".modal", a dialog selector). Use this on large pages — it slashes output and avoids truncation. Refs stay valid for the rest of the page.
- fullText=true: include STATIC text the interactive view drops — validation errors, prices, instructions, toasts, char counters. Reach for this when an action seemed to fail but no error showed, or when you need on-page copy.

Cross-origin iframes (e.g. Stripe payment frames) are listed as placeholders below the tree — their fields are NOT in the snapshot; fill them via coordinate click + browser_type.
Very large snapshots are truncated with a note rather than failing — scope to recover the rest.`,
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
    json: z
      .boolean()
      .optional()
      .default(false)
      .describe('Return structured JSON with refs dictionary (default: false)'),
    scope: z
      .string()
      .optional()
      .describe('CSS selector to limit the snapshot to one region, e.g. "form", "#main", ".modal". Greatly reduces size on large pages; refs elsewhere stay valid.'),
    fullText: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include static text (validation errors, prices, instructions) that the interactive view omits (default: false).'),
    includeUrls: z
      .boolean()
      .optional()
      .default(false)
      .describe('Inline link/element URLs — disambiguates junk-labeled links and avoids extra "get attr href" calls (default: false).'),
  },
  async (args) => {
    const result = await browserFetch('snapshot', {
      interactive: args.interactive,
      compact: args.compact,
      json: args.json,
      scope: args.scope,
      fullText: args.fullText,
      includeUrls: args.includeUrls,
    })
    if (!result.success) return errorResult(result.error!)

    const data = result.data as Record<string, unknown>
    const tabCount = typeof data.tabCount === 'number' ? data.tabCount : 0
    let text = data.snapshot
      ? String(data.snapshot)
      : JSON.stringify(data, null, 2)

    text += tabManager.formatTabStatus(tabCount)

    return {
      content: [{ type: 'text' as const, text }],
    }
  }
)

const browserClickTool = tool(
  'browser_click',
  `Click an element on the page by its ref (e.g., @e1). Get refs from browser_snapshot.`,
  {
    ref: z.string().describe('Element ref from snapshot (e.g., "@e1")'),
  },
  async (args) => {
    const result = await browserFetch('click', { ref: args.ref })
    if (!result.success) return errorResult(result.error!)
    const data = result.data as Record<string, unknown> | undefined
    const tabInfo = data?.tabInfo as { activeId: string; activeUrl: string; tabCount: number } | undefined
    const digest = (data?.digest as UrlDigest | undefined) ?? null

    let text = `Clicked ${args.ref}.${formatUrlDigest(digest)}`
    if (tabInfo) {
      text += tabManager.formatTabNotification(tabInfo)
    } else {
      text += getTabWarning()
    }

    return {
      content: [{ type: 'text' as const, text }],
    }
  }
)

const browserFillTool = tool(
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
    const data = result.data as Record<string, unknown> | undefined
    const committed = typeof data?.committedValue === 'string' ? data.committedValue : null
    let text = `Filled ${args.ref}.${formatFillReadback(args.value, committed)}`
    text += getTabWarning()
    return {
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
    }
  }
)

const browserScrollTool = tool(
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
    const data = result.data as Record<string, unknown> | undefined
    const scrollInfo = (data?.scrollInfo as ScrollInfo | undefined) ?? null
    let text = `Scrolled ${args.direction}${args.amount ? ` by ${args.amount}px` : ''}.${formatScrollDigest(scrollInfo)}`
    text += getTabWarning()
    return {
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
    }
  }
)

const browserWaitTool = tool(
  'browser_wait',
  `Wait for a CSS selector to appear on the page. Only use this when you need to wait for a specific element to render (e.g. after triggering dynamic content). Do NOT use for "networkidle", "load", or "domcontentloaded" — browser_open already waits for the page to load.`,
  {
    for: z
      .string()
      .describe(
        'CSS selector to wait for (e.g. "#results", ".loaded"). Avoid "networkidle"/"load"/"domcontentloaded" — browser_open already handles page load.'
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

const browserPressTool = tool(
  'browser_press',
  `Press ONE keyboard key (or a modifier combo). Use this for Enter (submit forms), Tab (next field), Escape (close dialogs), or key combos like "Control+a".

This cannot type text — multi-character strings are rejected. To type into the currently focused element (e.g. fields inside payment iframes), use browser_type; to replace an input's content by ref, use browser_fill.`,
  {
    key: z.string().describe('A single key or modifier combo (e.g., "Enter", "Tab", "Escape", "Control+a", "ArrowDown") — never a text string'),
  },
  async (args) => {
    const result = await browserFetch('press', { key: args.key })
    if (!result.success) return errorResult(result.error!)
    const data = result.data as Record<string, unknown> | undefined
    const tabInfo = data?.tabInfo as { activeId: string; activeUrl: string; tabCount: number } | undefined
    const digest = (data?.digest as UrlDigest | undefined) ?? null

    let text = `Pressed "${args.key}".${formatUrlDigestBrief(digest)}`
    if (tabInfo) {
      text += tabManager.formatTabNotification(tabInfo)
    } else {
      text += getTabWarning()
    }

    return {
      content: [{ type: 'text' as const, text }],
    }
  }
)

const browserScreenshotTool = tool(
  'browser_screenshot',
  `Take a screenshot of the current page. Returns the screenshot image and the file path where it was saved. Use full=true to capture the entire scrollable page. Use annotate=true to overlay numbered labels on interactive elements — each label [N] corresponds to ref @eN, so you can click elements by their visual label.`,
  {
    full: z
      .boolean()
      .optional()
      .default(false)
      .describe('Capture full scrollable page (default: false, viewport only)'),
    annotate: z
      .boolean()
      .optional()
      .default(false)
      .describe('Overlay numbered labels on interactive elements matching snapshot refs (default: false)'),
  },
  async (args) => {
    const result = await browserFetch('screenshot', { full: args.full, annotate: args.annotate })
    if (!result.success) return errorResult(result.error!)
    const data = result.data as Record<string, unknown>
    const rawOutput = data.output ? String(data.output) : ''
    const filePath = rawOutput ? extractScreenshotPath(rawOutput) : ''

    const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = []

    if (filePath) {
      const image = await readScreenshotAsBase64(filePath)
      if (image) {
        content.push({ type: 'image' as const, data: image.data, mimeType: image.mimeType })
      }
      // For annotated screenshots, include the ref legend after the file path
      const cleanOutput = stripAnsi(rawOutput).trim()
      const legendStart = cleanOutput.indexOf('\n')
      const legend = legendStart > 0 ? cleanOutput.slice(legendStart).trim() : ''
      const textParts = [`Screenshot saved to: ${filePath}`]
      if (legend) textParts.push(legend)
      content.push({ type: 'text' as const, text: textParts.join('\n') })
    } else {
      content.push({ type: 'text' as const, text: 'Screenshot taken.' })
    }

    return { content }
  }
)

const browserSelectTool = tool(
  'browser_select',
  `Select an option in a NATIVE <select> element by its ref, using the option's value or visible label. The committed value is verified by read-back and returned — if nothing committed, this errors instead of pretending.

Custom dropdowns (divs with role=combobox/listbox) will NOT work with this tool. For those: browser_click the trigger, re-snapshot, type into the popup's filter input, click the option's fresh ref, then re-snapshot to verify.`,
  {
    ref: z.string().describe('Select element ref from snapshot (e.g., "@e3")'),
    value: z.string().describe('The option value or visible label to select'),
  },
  async (args) => {
    const result = await browserFetch('select', { ref: args.ref, value: args.value })
    if (!result.success) return errorResult(result.error!)
    const data = result.data as Record<string, unknown> | undefined
    const committed = data?.committedValue
    return {
      content: [
        { type: 'text' as const, text: `Selected "${args.value}" in ${args.ref} — committed value verified: "${committed}".` },
      ],
    }
  }
)

const browserHoverTool = tool(
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

const browserUploadTool = tool(
  'browser_upload',
  `Upload a local file into a web page <input type="file"> using Playwright setInputFiles.

Use this instead of browser_run("upload ..."). The agent-browser upload command is known to create zero-byte uploads on some sites.

The selector must target the actual file input element, such as input[type="file"] or input.dz-hidden-input. Hidden file inputs are supported.`,
  {
    filePath: z.string().describe('Path to the local file to upload, usually under /workspace/uploads/...'),
    selector: z
      .string()
      .optional()
      .default('input[type="file"]')
      .describe('CSS selector for the target <input type="file"> element. Defaults to input[type="file"].'),
  },
  async (args) => {
    const result = await browserFetch('upload', {
      filePath: args.filePath,
      selector: args.selector,
    })
    if (!result.success) return errorResult(result.error!)

    const data = result.data as Record<string, any>
    const file = data.file as { name?: string; size?: number } | undefined
    let text = file?.name
      ? `Uploaded ${file.name} (${file.size ?? 'unknown'} bytes) to ${args.selector}.`
      : `Uploaded file to ${args.selector}.`
    text += getTabWarning()

    return {
      content: [{ type: 'text' as const, text }],
    }
  }
)

const browserDownloadTool = tool(
  'browser_download',
  `Download a file or page asset (image, PDF, CSV, ...) into the workspace THROUGH the browser — the browser's cookies and login state apply, so this works for assets behind a login that curl/fetch outside the browser cannot reach. The bytes travel over the browser connection, so it also works when the browser runs outside the container (host Chrome, remote providers).

Files are saved under /workspace/downloads/ and the saved path is returned.

- Get the asset URL from the page first: browser_snapshot with includeUrls, browser_run("get attr @eN src"), or browser_eval (e.g. document.querySelector('img.profile-photo').src).
- Supports http(s) URLs, blob: URLs (files the page generated — fetched from the current page), and data: URLs.
- Links/buttons that trigger a browser download can also just be clicked — those files land in /workspace/downloads/ too.`,
  {
    url: z.string().describe('URL of the file to download — an <img> src, <a> href, blob: or data: URL'),
    filename: z
      .string()
      .optional()
      .describe('Optional filename to save as (basename only). Derived from the URL/response headers when omitted.'),
  },
  async (args) => {
    const result = await browserFetch('download', { url: args.url, filename: args.filename })
    if (!result.success) return errorResult(result.error!)
    const data = result.data as { file?: { name: string; path: string; size: number; contentType: string | null } }
    const file = data.file
    if (!file) return errorResult('Download did not return file info')

    let text = `Downloaded to ${file.path} (${file.size} bytes${file.contentType ? `, ${file.contentType}` : ''}).`
    if (file.contentType === 'text/html') {
      text += '\nWARNING: the response is an HTML page, not a file asset — this is usually a login or error page. Check the URL or your session.'
    }
    return {
      content: [{ type: 'text' as const, text }],
    }
  }
)

const browserTypeTool = tool(
  'browser_type',
  `Type text with REAL keystrokes into the currently focused element — or pass a ref to focus that element first.

Use this when browser_fill cannot work:
- Fields inside cross-origin payment iframes (Stripe card number/expiry/CVC): click into the field first (by ref if available, else by coordinates via browser_run mouse), then call browser_type WITHOUT a ref. Verify with a screenshot — the field is not readable from outside the iframe.
- Keystroke-listening widgets that ignore programmatic fill: OTP digit boxes, typeaheads, autocomplete inputs.

Notes: this APPENDS to existing content (it does not clear first — use browser_fill to replace, or browser_press "Control+a" then type). When a ref is provided, the field's value is read back and returned.`,
  {
    text: z.string().describe('The text to type with real key events'),
    ref: z.string().optional().describe('Optional element ref to focus before typing (e.g. "@e4"). Omit when the target is inside a payment iframe — focus it by clicking first.'),
  },
  async (args) => {
    const result = await browserFetch('type', { text: args.text, ref: args.ref })
    if (!result.success) return errorResult(result.error!)
    const data = result.data as Record<string, unknown> | undefined
    let text: string
    if (data && typeof data.committedValue === 'string') {
      text = `Typed ${args.text.length} chars into ${args.ref} — field value is now: "${data.committedValue}".`
    } else {
      text = `Typed ${args.text.length} chars into the focused element. If the field is inside a payment iframe, verify visually with browser_screenshot.`
    }
    text += getTabWarning()
    return {
      content: [{ type: 'text' as const, text }],
    }
  }
)

const browserEvalTool = tool(
  'browser_eval',
  `Run JavaScript in the page and return the result. Prefer this over browser_run("eval ...").

- A single expression returns its value (e.g. document.title). A multi-line/statement body runs in a fresh scope — use \`return\` to produce a value (top-level return and await are supported; const/let won't collide across calls). Bare function expressions are auto-invoked.
- Return JSON-serializable data — for structured results, end with JSON.stringify(...).
- TOP FRAME ONLY: elements inside cross-origin iframes (e.g. Stripe payment frames) are unreachable from JavaScript. For those, click the field by coordinates and type with browser_type.
- Output is capped at ~8000 chars — query only the fields you need instead of dumping HTML.`,
  {
    script: z.string().describe('JavaScript to evaluate. An expression (document.title) returns its value; a statement body should use return, e.g. "const n = document.querySelectorAll(\'a\').length; return n;"'),
  },
  async (args) => {
    const result = await browserFetch('eval', { script: args.script })
    if (!result.success) return errorResult(result.error!)
    const data = result.data as Record<string, unknown>
    let text = data.output ? String(data.output) : '(no output)'
    if (data.wrapped) {
      text += '\n(note: ran in a fresh function scope — add `return` if you expected a value back)'
    }
    text += getTabWarning()
    return {
      content: [{ type: 'text' as const, text }],
    }
  }
)

const browserRunTool = tool(
  'browser_run',
  `Run any agent-browser CLI command. Use this for advanced browser operations not covered by the dedicated tools.

Provide EXACTLY ONE of (never include the "agent-browser" prefix):
- args (PREFERRED whenever any argument contains spaces or quotes): pre-tokenized argv array. Each element reaches the CLI verbatim — no quoting or escaping rules to get wrong. Examples: {"args": ["type", "@e1", "chat isn't enough"]} · {"args": ["frame", "iframe[title=\\"Payment frame\\"]"]} · {"args": ["find", "role", "button", "click", "--name", "View demo"]}
- command: a single command-line string, fine for simple commands like {"command": "get url"}. Shell-style quoting; when in doubt, use args.

Available commands:
- dblclick <ref> — Double-click element
- focus <ref> — Focus element
- type <ref> <text> — Type text (appends, unlike fill which clears first)
- keydown/keyup <key> — Hold/release key
- check/uncheck <ref> — Toggle checkbox
- scrollintoview <ref> — Scroll element into view
- drag <srcRef> <tgtRef> — Drag and drop
- eval <js> — Run JavaScript (prefer the dedicated browser_eval tool)
- get text/html/value/attr/title/url/count/box <ref> — Get element info
- is visible/enabled/checked <ref> — Check element state
- find role/text/label/placeholder/alt/title/testid <query> <action> — Semantic locators
- back / forward / reload — Navigation
- tab / tab new [--label <name>] [url] / tab <id|label> / tab close [<id|label>] — Tab management. Tabs have STABLE string ids like t1, t2 (shown by "tab"); bare integers are rejected
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
    command: z.string().optional().describe('Command string for simple commands, e.g. "get url". Provide either this or args, not both.'),
    args: z.array(z.string()).optional().describe('Pre-tokenized argv — preferred when any argument contains spaces or quotes, e.g. ["fill", "@e1", "hello world"]. Provide either this or command, not both.'),
  },
  async (args) => {
    if ((args.command === undefined) === (args.args === undefined)) {
      return errorResult('Provide exactly one of "command" (string) or "args" (array of strings).')
    }
    const result = await browserFetch('run', { command: args.command, args: args.args })
    if (!result.success) return errorResult(result.error!)
    const data = result.data as Record<string, unknown>
    let text = data.output ? String(data.output) : 'Command executed.'
    const tabInfo = data.tabInfo as { activeId: string; activeUrl: string; tabCount: number } | undefined
    if (tabInfo) {
      text += tabManager.formatTabNotification(tabInfo)
    } else {
      text += getTabWarning()
    }
    return {
      content: [
        { type: 'text' as const, text },
      ],
    }
  }
)

const browserGetStateTool = tool(
  'browser_get_state',
  `Get the current state of the browser in one call. Returns the current URL, a screenshot image, and an accessibility snapshot. Use this to quickly check what the browser is showing without needing multiple tool calls.`,
  {},
  async () => {
    const [urlResult, screenshotResult, snapshotResult] = await Promise.all([
      browserFetch('run', { command: 'get url' }),
      browserFetch('screenshot', { full: false }),
      browserFetch('snapshot', { interactive: true, compact: true }),
    ])

    const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = []
    const parts: string[] = []

    if (urlResult.success) {
      const data = urlResult.data as Record<string, unknown>
      parts.push(`**Current URL:** ${data.output || 'unknown'}`)
    } else {
      parts.push(`**Current URL:** Error - ${urlResult.error}`)
    }

    if (screenshotResult.success) {
      const data = screenshotResult.data as Record<string, unknown>
      const rawOutput = data.output ? String(data.output) : ''
      const filePath = rawOutput ? extractScreenshotPath(rawOutput) : ''
      if (filePath) {
        const image = await readScreenshotAsBase64(filePath)
        if (image) {
          content.push({ type: 'image' as const, data: image.data, mimeType: image.mimeType })
        }
        parts.push(`**Screenshot:** ${filePath}`)
      } else {
        parts.push(`**Screenshot:** No screenshot path returned`)
      }
    } else {
      parts.push(`**Screenshot:** Error - ${screenshotResult.error}`)
    }

    if (snapshotResult.success) {
      const data = snapshotResult.data as Record<string, unknown>
      const tabCount = typeof data.tabCount === 'number' ? data.tabCount : 0
      const snapshot = data.snapshot
        ? String(data.snapshot)
        : JSON.stringify(data, null, 2)
      parts.push(`**Accessibility Snapshot:**\n${snapshot}`)
      const tabStatus = tabManager.formatTabStatus(tabCount)
      if (tabStatus) parts.push(tabStatus.trim())
    } else {
      parts.push(`**Accessibility Snapshot:** Error - ${snapshotResult.error}`)
    }

    content.push({ type: 'text' as const, text: parts.join('\n\n') })

    return { content }
  }
)

  return [
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
    browserUploadTool,
    browserDownloadTool,
    browserTypeTool,
    browserEvalTool,
    browserRunTool,
    browserGetStateTool,
  ]
}
