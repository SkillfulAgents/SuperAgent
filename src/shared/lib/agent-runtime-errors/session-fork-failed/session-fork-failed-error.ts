import { z } from 'zod'

import { AgentRuntimeError, agentRuntimeErrorBodySchema } from '../agent-runtime-error'

export const SESSION_FORK_FAILED = 'session_fork_failed'

export const sessionForkFailedBodySchema = agentRuntimeErrorBodySchema.extend({
  code: z.literal(SESSION_FORK_FAILED),
})

export class SessionForkFailedError extends AgentRuntimeError {
  readonly code = SESSION_FORK_FAILED
  protected readonly bodySchema = sessionForkFailedBodySchema

  constructor(
    readonly status: 404 | 409 | 500,
    message: string,
  ) {
    super(message)
    this.name = 'SessionForkFailedError'
  }
}
