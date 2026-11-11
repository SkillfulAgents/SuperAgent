/**
 * The script of the agents' objects when the org runs as three scripts (split/main.ts): an
 * agent's object, its actor and its container's outbound calls, without the API.
 */
import { WorkerEntrypoint, type Fetcher } from 'cloudflare:workers'
import { runWithBackground } from '@shared/lib/background'
import { serveContainerCall } from '../cloudflare-agent'
import { logErrorsAsText } from '../error-logs'
import type { Env } from '../index'

export { AgentDurableObject } from '../cloudflare-agent'

interface AgentEnv extends Env {
  /** The main script's AgentHostCalls: the API a container reaches at http://host.internal. */
  HOST: Fetcher
}

/** A container's calls to http://host.internal and http://workspace.internal, which its AgentDurableObject routes here (ctx.exports, by this name). */
export class AgentContainerOutbound extends WorkerEntrypoint<AgentEnv, { containerId: string }> {
  fetch(request: Request): Promise<Response> {
    return runWithBackground(this.ctx, () => serveContainerCall(request, this.env, this.ctx.props.containerId, (call) => this.env.HOST.fetch(call)))
  }
}

logErrorsAsText()

export default {
  fetch: () => new Response(null, { status: 404 }),
}
