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
export function describeExecFailure(err: ExecFailure, verb: string, timeoutMs: number): string {
  const detail = [err.stdout?.trim(), err.stderr?.trim()].filter(Boolean).join('\n')
  const stopped = err.killed === true || err.signal === 'SIGTERM' || err.signal === 'SIGKILL'
  if (stopped && /maxBuffer/i.test(err.message ?? '')) {
    return `agent-browser ${verb} was stopped: its output exceeded the buffer limit.${detail ? `\n${detail}` : ''}`
  }
  if (stopped) {
    const seconds = Math.round(timeoutMs / 1000)
    return `agent-browser ${verb} produced no result within ${seconds}s and was stopped.${detail ? `\n${detail}` : ''}`
  }
  if (detail) return detail
  const code = err.code === null || err.code === undefined ? 'unknown' : String(err.code)
  return `agent-browser ${verb} failed (exit ${code}) without output.`
}
