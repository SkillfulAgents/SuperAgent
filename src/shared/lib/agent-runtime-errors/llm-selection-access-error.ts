import { AgentRuntimeError } from './agent-runtime-error'

export const LLM_PROVIDER_NOT_FOUND = 'llm_provider_not_found'

/** The selected LLM provider is gone, or this user may not bind it. Both read as "not found". */
export class LlmSelectionAccessError extends AgentRuntimeError {
  readonly code = LLM_PROVIDER_NOT_FOUND
  readonly status = 404

  constructor() {
    super('LLM provider not found')
    this.name = 'LlmSelectionAccessError'
  }
}
