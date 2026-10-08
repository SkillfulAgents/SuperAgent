import { describe, expect, it } from 'vitest'

import { MessageNotAcceptedError } from '@shared/lib/container/message-dispatch-error'

import { agentRuntimeErrorBodySchema, findAgentRuntimeError } from './agent-runtime-error'
import { AgentContainerStopError } from './agent-container-stop-failed/agent-container-stop-error'
import { LlmSelectionAccessError } from './llm-provider-not-found/llm-selection-access-error'

describe('findAgentRuntimeError', () => {
  it('finds the error when a send wraps it as the cause', () => {
    const runtimeError = new LlmSelectionAccessError()
    const wrapped = new MessageNotAcceptedError('rejected', 'Failed to send message', { cause: runtimeError })

    expect(findAgentRuntimeError(wrapped)).toBe(runtimeError)
  })

  it('returns null for an ordinary error or a cause cycle', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    ;(a as { cause?: unknown }).cause = b

    expect(findAgentRuntimeError(new Error('Failed to send message'))).toBeNull()
    expect(findAgentRuntimeError(b)).toBeNull()
    expect(findAgentRuntimeError('not an error')).toBeNull()
  })
})

describe('toHttpResponse', () => {
  it('returns the status and a body with code and message', async () => {
    const res = new LlmSelectionAccessError().toHttpResponse()

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ code: 'llm_provider_not_found', error: 'LLM provider not found' })
  })

  it('sends the user-facing message, not the internal one', async () => {
    const error = new AgentContainerStopError('research-agent', new Error('runtime wedged'))
    const body = agentRuntimeErrorBodySchema.parse(await error.toHttpResponse().json())

    expect(error.message).toContain('runtime wedged')
    expect(body.code).toBe('agent_container_stop_failed')
    expect(body.error).not.toContain('runtime wedged')
  })
})
