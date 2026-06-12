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

/** Generous backstop for successful output (~25k tokens). Tool-level caps
 * (e.g. browser_eval's 8k) apply on top of this. */
export const MAX_BROWSER_OUTPUT_CHARS = 100_000

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
