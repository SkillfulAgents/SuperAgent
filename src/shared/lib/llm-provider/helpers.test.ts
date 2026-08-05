import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetApiKeyStatus = vi.fn()
const mockCreateClient = vi.fn()

vi.mock('./index', () => ({
  getActiveLlmProvider: () => ({
    getApiKeyStatus: mockGetApiKeyStatus,
    createClient: mockCreateClient,
  }),
}))

// createSummarizerText wraps its calls in withRetry; run it as a passthrough
// so failure-path tests don't sit through backoff delays.
vi.mock('../utils/retry', () => ({
  withRetry: (fn: () => Promise<unknown>) => fn(),
}))

import { getConfiguredLlmClient, extractTextFromLlmResponse, createSummarizerText, SUMMARIZER_MAX_TOKENS } from './helpers'
import type Anthropic from '@anthropic-ai/sdk'

describe('getConfiguredLlmClient', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns client when API key is configured', () => {
    const fakeClient = { messages: {} }
    mockGetApiKeyStatus.mockReturnValue({ isConfigured: true })
    mockCreateClient.mockReturnValue(fakeClient)

    const client = getConfiguredLlmClient()
    expect(client).toBe(fakeClient)
    expect(mockCreateClient).toHaveBeenCalledOnce()
  })

  it('throws when API key is not configured', () => {
    mockGetApiKeyStatus.mockReturnValue({ isConfigured: false })

    expect(() => getConfiguredLlmClient()).toThrow('LLM API key not configured')
    expect(mockCreateClient).not.toHaveBeenCalled()
  })
})

describe('extractTextFromLlmResponse', () => {
  function textBlock(text: string): Anthropic.TextBlock {
    return { type: 'text', text, citations: null }
  }

  function makeResponse(content: Anthropic.ContentBlock[]): Anthropic.Message {
    return { content } as Anthropic.Message
  }

  it('extracts text from a single text block', () => {
    const response = makeResponse([textBlock('  Hello world  ')])
    expect(extractTextFromLlmResponse(response)).toBe('Hello world')
  })

  it('returns first text block when multiple exist', () => {
    const response = makeResponse([
      textBlock('first'),
      textBlock('second'),
    ])
    expect(extractTextFromLlmResponse(response)).toBe('first')
  })

  it('skips non-text blocks', () => {
    const response = makeResponse([
      { type: 'tool_use', id: 't1', name: 'foo', input: {} } as Anthropic.ContentBlock,
      textBlock('after tool'),
    ])
    expect(extractTextFromLlmResponse(response)).toBe('after tool')
  })

  it('returns null when no text blocks', () => {
    const response = makeResponse([
      { type: 'tool_use', id: 't1', name: 'foo', input: {} } as Anthropic.ContentBlock,
    ])
    expect(extractTextFromLlmResponse(response)).toBeNull()
  })

  it('returns null for empty content array', () => {
    const response = makeResponse([])
    expect(extractTextFromLlmResponse(response)).toBeNull()
  })

  it('returns null for whitespace-only text', () => {
    const response = makeResponse([textBlock('   ')])
    expect(extractTextFromLlmResponse(response)).toBeNull()
  })
})

describe('createSummarizerText', () => {
  function textResponse(text: string, stopReason = 'end_turn') {
    return { content: [{ type: 'text', text }], stop_reason: stopReason }
  }

  const thinkingOnlyResponse = {
    content: [{ type: 'thinking', thinking: 'ruminating…' }],
    stop_reason: 'max_tokens',
  }

  function clientWith(create: ReturnType<typeof vi.fn>): Anthropic {
    return { messages: { create } } as unknown as Anthropic
  }

  const REQUEST = { model: 'some-model', messages: [{ role: 'user' as const, content: 'name this' }] }

  let create: ReturnType<typeof vi.fn>

  beforeEach(() => {
    create = vi.fn()
  })

  it('applies the summarizer token budget to the request', async () => {
    create.mockResolvedValue(textResponse('A Name'))
    const result = await createSummarizerText(clientWith(create), REQUEST)
    expect(result).toBe('A Name')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'some-model',
      max_tokens: SUMMARIZER_MAX_TOKENS,
    }))
  })

  it('retries with a thinking cap when the response carries no text', async () => {
    create
      .mockResolvedValueOnce(thinkingOnlyResponse)
      .mockResolvedValueOnce(textResponse('After Retry'))
    const result = await createSummarizerText(clientWith(create), REQUEST)
    expect(result).toBe('After Retry')
    expect(create).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({
      max_tokens: SUMMARIZER_MAX_TOKENS,
      thinking: expect.objectContaining({ type: 'enabled' }),
    }))
  })

  it('retries even when a text-less response reports a non-max_tokens stop reason', async () => {
    create
      .mockResolvedValueOnce({ content: [{ type: 'thinking', thinking: 'x' }], stop_reason: 'end_turn' })
      .mockResolvedValueOnce(textResponse('Recovered'))
    expect(await createSummarizerText(clientWith(create), REQUEST)).toBe('Recovered')
  })

  it('returns null when the retry also yields no text', async () => {
    create.mockResolvedValue(thinkingOnlyResponse)
    expect(await createSummarizerText(clientWith(create), REQUEST)).toBeNull()
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('returns null instead of throwing when the endpoint rejects the thinking param', async () => {
    create
      .mockResolvedValueOnce(thinkingOnlyResponse)
      .mockRejectedValueOnce(new Error('thinking is not supported with this model'))
    expect(await createSummarizerText(clientWith(create), REQUEST)).toBeNull()
  })
})
