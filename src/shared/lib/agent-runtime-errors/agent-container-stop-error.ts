import { AgentRuntimeError, type AgentRuntimeErrorBody } from './agent-runtime-error'

export const AGENT_CONTAINER_STOP_FAILED = 'agent_container_stop_failed'

/**
 * The container could not be stopped, so deleteAgent aborted before removing the
 * workspace. The agent is preserved and the delete is retryable (SUP-209).
 */
export class AgentContainerStopError extends AgentRuntimeError {
  readonly code = AGENT_CONTAINER_STOP_FAILED
  readonly status = 409

  constructor(readonly slug: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to stop the container for agent "${slug}": ${detail}`)
    this.name = 'AgentContainerStopError'
  }

  protected override body(): AgentRuntimeErrorBody {
    return {
      code: this.code,
      error: "Couldn't stop the agent's container, so it wasn't deleted. It may be busy — please try again in a moment.",
    }
  }
}
