/**
 * Bundled in place of Node-only packages that a Worker never runs (wrangler `alias`), so they are
 * neither bundled nor evaluated when an isolate starts:
 * - `express` and `raw-body`: only Slack Bolt's HTTP receivers use them; the Slack connector uses
 *   Socket Mode and webhook signature checks. Together with iconv-lite's tables they are about 2 MB.
 * - `@skillful-agents/agent-computer`: it runs `fileURLToPath(import.meta.url)` at import, which
 *   throws in a Worker. Computer use never runs on Cloudflare.
 * - `undici`: the MCP fetch pins DNS answers with an undici `Agent` as `dispatcher`. A Worker's fetch
 *   ignores `dispatcher`, and Cloudflare does not route a Worker's fetch to private addresses, so
 *   this `Agent` does nothing.
 */
const unavailable = () => new Error('This Node-only package is not available in a Worker')

/** `express()` and `getRawBody()`, the default export of both packages. */
function nodeOnly(): never {
  throw unavailable()
}
nodeOnly.Router = nodeOnly
nodeOnly.json = nodeOnly
nodeOnly.urlencoded = nodeOnly
nodeOnly.raw = nodeOnly
nodeOnly.text = nodeOnly
nodeOnly.static = nodeOnly

export default nodeOnly

export class AC {
  constructor() {
    throw unavailable()
  }
}

export function formatOutput(): never {
  throw unavailable()
}

export class Agent {
  constructor(_options?: unknown) {}

  close(): Promise<void> {
    return Promise.resolve()
  }
}
