/**
 * Bundled in place of `undici` (wrangler `alias`). SuperAgent's MCP fetch passes an undici `Agent` as
 * `dispatcher` to pin DNS answers to public addresses. A Worker has no sockets for undici and its
 * fetch ignores `dispatcher`; Cloudflare does not route a Worker's fetch to private addresses.
 */
export class Agent {
  constructor(_options?: unknown) {}

  close(): Promise<void> {
    return Promise.resolve()
  }
}
