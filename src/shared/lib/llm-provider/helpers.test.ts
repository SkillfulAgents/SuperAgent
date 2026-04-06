import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetApiKeyStatus = vi.fn()
const mockCreateClient = vi.fn()

vi.mock('./index', () => ({
  getActiveLlmProvider: () => ({
    getApiKeyStatus: mockGetApiKeyStatus,
    createClient: mockCreateClient,
  }),
}))

import { getConfiguredLlmClient, extractTextFromLlmResponse } from './helpers'
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
