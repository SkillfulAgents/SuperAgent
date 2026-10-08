import { AgentRuntimeError } from './agent-runtime-error'

export const SESSION_FORK_FAILED = 'session_fork_failed'

export class ForkSessionError extends AgentRuntimeError {
  readonly code = SESSION_FORK_FAILED

  constructor(
    readonly status: 404 | 409 | 500,
    message: string,
  ) {
    super(message)
    this.name = 'ForkSessionError'
  }
}
