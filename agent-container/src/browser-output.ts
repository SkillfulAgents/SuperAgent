/**
 * Output bounding + sanitization for agent-browser CLI results
 * (browser-tools audit P0 #6).
 *
 * Two failure shapes this prevents:
 * - execFile's maxBuffer overflow used to THROW with up to 1 MiB of partial
 *   stdout, which execBrowser then stuffed into the error string returned to
 *   the model — a token bomb in the worst place.
 * - error.message includes the full command line with the CDP WebSocket URL
 *   (`agent-browser --cdp ws://192.168.5.2:.../devtools/browser/...`), which
 *   leaked connection internals into agent-visible errors.
 */

/**
 * Backstop for successful output. The SDK's tool-result limit is ~25k
 * tokens, which token-dense CLI text (a11y trees, request logs, URLs) hits
 * around 62–74k chars — nondeterministically at the edge. The old 100k cap
 * sat above that, so a busy `network requests` or `console` dump was capped
 * to 100k and then hard-errored anyway, leaving the agent nothing
 * (transcript-mining theme 22). 50k stays under the limit even for the
 * densest output. Tool-level caps (browser_eval's 8k, the snapshot soft
 * cap) apply on top of this.
 */
export const MAX_BROWSER_OUTPUT_CHARS = 50_000

/**
 * Raw ceiling for the snapshot route only. Its own capSnapshot truncates to
 * SNAPSHOT_SOFT_CAP_CHARS and reports the true total; capping earlier would
 * make that total the exec cap's, not the tree's. fullText also fetches the
 * unfiltered tree and compacts it here, which needs the whole thing.
 */
export const MAX_SNAPSHOT_RAW_CHARS = 2_000_000

/** Errors are for reading, not dumping — keep them tight. */
export const MAX_BROWSER_ERROR_CHARS = 4_000

/** Truncate to `cap` chars with an explicit notice carrying both sizes. */
export function capBrowserOutput(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n…[output truncated — showing ${cap} of ${text.length} chars]`
}

/** Redact CDP WebSocket URLs from agent-visible error text. */
export function redactCdpUrls(text: string): string {
  return text.replace(/wss?:\/\/\S+/g, 'ws://<redacted>')
}

/** Wall-clock ceiling for one agent-browser invocation. */
export const BROWSER_EXEC_TIMEOUT_MS = 30_000

/** The parts of execFile's rejection that decide what the agent is told. */
export interface ExecFailure {
  killed?: boolean
  signal?: string | null
  code?: number | string | null
  stdout?: string
  stderr?: string
  message?: string
}

/**
 * Agent-visible text for a failed agent-browser invocation.
 *
 * The CLI writes its own "✗ …" diagnostics to stdout/stderr, and those are
 * the message whenever they exist. When neither does — the exec timeout
 * killed the process, the binary is missing — Node's error.message is
 * `Command failed: agent-browser <every argv element>`: the agent's whole
 * eval script or typed text echoed back as if it were the error, with no
 * exit code and the word "timeout" nowhere (transcript-mining theme 21;
 * one agent read a 29-second eval kill as "my script is the problem").
 * That message is for the container log. The agent gets the verb and the
 * cause the exec layer can actually vouch for.
 */
export function describeExecFailure(err: ExecFailure, verb: string, elapsedMs: number): string {
  const detail = [err.stdout?.trim(), err.stderr?.trim()].filter(Boolean).join('\n')
  const tail = detail ? `\n${detail}` : ''
  const ms = Math.max(0, Math.round(elapsedMs))
  // Stopping the CLI client says nothing about the page: an eval it started
  // keeps running in the browser. Say so rather than imply cancellation.
  const unknown = ' The CLI call was stopped; whether the page-side action completed is not known.'
  // Node sets `killed` only when execFile itself stopped the child (its
  // timeout or maxBuffer). A signal without it came from outside and is
  // reported as that — not as the exec ceiling.
  if (err.killed === true && /maxBuffer/i.test(err.message ?? '')) {
    return `agent-browser ${verb} was stopped after ${ms} ms: its output exceeded the buffer limit.${unknown}${tail}`
  }
  if (err.killed === true) {
    return `agent-browser ${verb} produced no result within ${ms} ms and was stopped.${unknown}${tail}`
  }
  if (err.signal) {
    return `agent-browser ${verb} was terminated by ${err.signal} after ${ms} ms${detail ? '.' : ' with no output.'}${unknown}${tail}`
  }
  if (detail) return detail
  const code = err.code === null || err.code === undefined ? 'unknown' : String(err.code)
  return `agent-browser ${verb} failed (exit ${code}) without output.`
}

// --- WebMCP notices ------------------------------------------------------------

/**
 * agent-browser 0.36+ announces a page's WebMCP tools (site-registered tools,
 * `document.modelContext`) on whichever command runs after the tool list
 * changes — an `eval` included, which would break every observer read that
 * parses eval output as JSON. The container sets AGENT_BROWSER_NO_WEBMCP=1,
 * which turns the feature off; this strip is the backstop for a browser or
 * CLI that announces anyway. The block has fixed delimiters: a summary line,
 * then the tools between nonce-tagged AGENT_BROWSER_PAGE_CONTENT markers.
 */
const WEBMCP_CHANGED_BLOCK =
  /(^|\n)WebMCP tools changed: \d+\.[^\n]*\n--- AGENT_BROWSER_PAGE_CONTENT nonce=(\S+) [^\n]*---\n[\s\S]*?\n--- END_AGENT_BROWSER_PAGE_CONTENT nonce=\2 ---(?=\n|$)/g
const WEBMCP_STATUS_LINE =
  /(^|\n)WebMCP (?:tools cleared; no page tools are currently available\.|state unavailable; do not reuse tools from an earlier response\.)(?=\n|$)/g

export function stripWebMcpNotices(text: string): string {
  if (!text.includes('WebMCP')) return text
  return text.replace(WEBMCP_CHANGED_BLOCK, '$1').replace(WEBMCP_STATUS_LINE, '$1').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The message of a `--json` failure envelope (`{"success":false,"error":…}`),
 * or the text unchanged when it is not one.
 */
export function cliJsonError(text: string): string {
  try {
    const parsed = JSON.parse(text.trim()) as { success?: unknown; error?: unknown }
    if (parsed && parsed.success === false && typeof parsed.error === 'string' && parsed.error) return parsed.error
  } catch { /* not an envelope */ }
  return text
}

// --- Screenshot output ---------------------------------------------------------

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

/** The absolute .png/.jpg path in a screenshot command's text output, or the cleaned text when there is none. */
export function extractScreenshotPath(output: string): string {
  const clean = stripAnsi(output).trim()
  const match = clean.match(/(\/\S+\.(?:png|jpe?g))/i)
  return match ? match[1] : clean
}
