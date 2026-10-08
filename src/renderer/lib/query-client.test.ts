import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CancelledError } from '@tanstack/react-query'

// Mock the toast + Sentry sinks so we can assert on them.
const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }))
vi.mock('./error-reporting', () => ({ captureRendererException: mockCapture }))

import { handleMutationError, handleQueryError, createAppQueryClient } from './query-client'
import { AgentRuntimeRequestError, readAgentRuntimeError } from '@shared/lib/agent-runtime-errors/agent-runtime-request-error'
import { LlmSelectionAccessError } from '@shared/lib/agent-runtime-errors/llm-provider-not-found/llm-selection-access-error'

beforeEach(() => {
  mockToastError.mockClear()
  mockCapture.mockClear()
})

describe('handleMutationError', () => {
  it('reports to Sentry and toasts the error message by default', () => {
    handleMutationError(new Error('boom'))
    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(mockCapture.mock.calls[0][1]).toMatchObject({ tags: { source: 'mutation' } })
    expect(mockToastError).toHaveBeenCalledWith('boom')
  })

  it('skips the toast (but still reports) when skipGlobalErrorToast is set', () => {
    handleMutationError(new Error('boom'), { skipGlobalErrorToast: true })
    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('uses meta.errorMessage as the toast text when provided', () => {
    handleMutationError(new Error('raw server detail'), { errorMessage: 'Friendly message' })
    expect(mockToastError).toHaveBeenCalledWith('Friendly message')
  })

  it('falls back to a generic message for a non-Error / empty value', () => {
    handleMutationError(undefined)
    expect(mockToastError).toHaveBeenCalledWith('Something went wrong. Please try again.')
  })

  it('toasts the server message for an AgentRuntimeError whose code has no preview', async () => {
    const error = await readAgentRuntimeError(new LlmSelectionAccessError().toHttpResponse(), 'Failed to send message')
    expect(error).toBeInstanceOf(AgentRuntimeRequestError)
    expect(error).toMatchObject({ status: 404, code: 'llm_provider_not_found' })

    handleMutationError(error, { agentRuntimeErrorsShownInline: true })
    expect(mockToastError).toHaveBeenCalledWith('LLM provider not found')
  })

  it('keeps the fallback message for an error body without a code', async () => {
    const res = new Response(JSON.stringify({ error: 'Failed to send message' }), { status: 500 })
    const error = await readAgentRuntimeError(res, 'Failed to send message')
    expect(error).not.toBeInstanceOf(AgentRuntimeRequestError)
    expect(error.message).toBe('Failed to send message')
  })

  it('passes through a thrown string', () => {
    handleMutationError('plain string error')
    expect(mockToastError).toHaveBeenCalledWith('plain string error')
  })
})

describe('handleQueryError', () => {
  it('reports to Sentry but does NOT toast by default (queries are silent)', () => {
    handleQueryError(new Error('fetch failed'))
    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(mockCapture.mock.calls[0][1]).toMatchObject({ tags: { source: 'query' } })
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('toasts when the query opts in via meta.showErrorToast', () => {
    handleQueryError(new Error('fetch failed'), { showErrorToast: true })
    expect(mockToastError).toHaveBeenCalledWith('fetch failed')
  })

  it('ignores a CancelledError entirely (no report, no toast)', () => {
    handleQueryError(new CancelledError())
    expect(mockCapture).not.toHaveBeenCalled()
    expect(mockToastError).not.toHaveBeenCalled()
  })
})

describe('createAppQueryClient wiring', () => {
  it('routes mutation cache errors through the mutation handler (report + default toast)', () => {
    const client = createAppQueryClient()
    const onError = client.getMutationCache().config.onError
    expect(onError).toBeTypeOf('function')

    // Simulate a mutation that did NOT opt out. v5 onError args:
    // (error, variables, onMutateResult, mutation, context).
    onError?.(new Error('mutate failed'), undefined, undefined, { options: { meta: undefined } } as never, undefined as never)
    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(mockToastError).toHaveBeenCalledWith('mutate failed')
  })

  it('respects a mutation that opts out of the toast via meta', () => {
    const client = createAppQueryClient()
    const onError = client.getMutationCache().config.onError

    onError?.(new Error('silent'), undefined, undefined, { options: { meta: { skipGlobalErrorToast: true } } } as never, undefined as never)
    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('routes query cache errors through the query handler (report, no default toast)', () => {
    const client = createAppQueryClient()
    const onError = client.getQueryCache().config.onError
    expect(onError).toBeTypeOf('function')

    onError?.(new Error('query failed'), { meta: undefined } as never)
    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(mockToastError).not.toHaveBeenCalled()
  })
})
