import { z } from 'zod'

import { AgentRuntimeError, agentRuntimeErrorBodySchema } from '../agent-runtime-error'

export const AGENT_CONTAINER_STOP_FAILED = 'agent_container_stop_failed'

export const agentContainerStopFailedBodySchema = agentRuntimeErrorBodySchema.extend({
  code: z.literal(AGENT_CONTAINER_STOP_FAILED),
})
type AgentContainerStopFailedBody = z.infer<typeof agentContainerStopFailedBodySchema>

/**
 * The container could not be stopped, so deleteAgent aborted before removing the
 * workspace. The agent is preserved and the delete is retryable (SUP-209).
 */
export class AgentContainerStopError extends AgentRuntimeError {
  readonly code = AGENT_CONTAINER_STOP_FAILED
  readonly status = 409
  protected readonly bodySchema = agentContainerStopFailedBodySchema

  constructor(readonly slug: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to stop the container for agent "${slug}": ${detail}`)
    this.name = 'AgentContainerStopError'
  }

  protected override body(): AgentContainerStopFailedBody {
    return {
      code: this.code,
      error: "Couldn't stop the agent's container, so it wasn't deleted. It may be busy — please try again in a moment.",
    }
  }
}
