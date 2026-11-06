/**
 * Bundled in place of `@skillful-agents/agent-computer` (wrangler `alias`). The package runs
 * `fileURLToPath(import.meta.url)` at import, which throws in a Worker and stops it from starting.
 * Computer use never runs on Cloudflare.
 */
const unavailable = () => new Error('Computer use is not available in a Worker')

export class AC {
  constructor() {
    throw unavailable()
  }
}

export function formatOutput(): never {
  throw unavailable()
}
