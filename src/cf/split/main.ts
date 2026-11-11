/**
 * The org's Worker when its Durable Objects are spread over three scripts, so each object's
 * isolate loads only its own code: this script (the UI, the API and the task manager object),
 * split/agent.ts and split/app-state.ts. Cloudflare loads a script whole into every isolate that
 * runs any of it, so in one script (index.ts) each object pays for the API.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import { runWithBackground } from '@shared/lib/background'
import worker, { serveHostCall, type Env } from '../index'

export { TaskManagerDurableObject } from '../cloudflare-task-manager-object'

export default worker

/** A container's calls to http://host.internal, which the agent script's AgentContainerOutbound sends on (its HOST binding). */
export class AgentHostCalls extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> {
    return runWithBackground(this.ctx, () => serveHostCall(request, this.env))
  }
}
