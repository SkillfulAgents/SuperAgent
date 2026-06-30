import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let memoryDir: string
const messagesCreate = vi.fn()
const getSessionMessagesMock = vi.fn()
const getChatIntegrationMock = vi.fn()
const markConsolidatedMock = vi.fn((..._args: unknown[]) => true)

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: (...args: unknown[]) => getChatIntegrationMock(...args),
}))
vi.mock('@shared/lib/services/session-service', () => ({
  getSessionMessages: (...args: unknown[]) => getSessionMessagesMock(...args),
}))
vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  markConversationConsolidated: (...args: unknown[]) => markConsolidatedMock(...args),
}))
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({ getDefaultModel: () => 'sonnet' }),
  resolveActiveProviderModel: () => 'claude-sonnet-4-6',
}))
vi.mock('@shared/lib/llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({ messages: { create: messagesCreate } }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extractTextFromLlmResponse: (resp: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = resp?.content?.find?.((x: any) => x.type === 'text')
    return b?.text?.trim() || null
  },
}))
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentMemoryDir: () => memoryDir,
}))

import { consolidateConversation } from './conversation-consolidation-service'
import type { ChatIntegrationSession } from '../db/schema'
import type { JsonlMessageEntry } from '../types/agent'

function makeConversation(over: Partial<ChatIntegrationSession> = {}): ChatIntegrationSession {
  const now = new Date()
  return {
    id: 'conv-1',
    integrationId: 'int-1',
    externalChatId: 'chat-1',
    sessionId: 'sess-1',
    displayName: null,
    archivedAt: now,
    rotatedAt: now,
    recap: null,
    consolidatedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as ChatIntegrationSession
}

function userEntry(text: string): JsonlMessageEntry {
  return { uuid: 'u', parentUuid: null, type: 'user', sessionId: 'sess-1', timestamp: '', message: { role: 'user', content: text } }
}
function assistantEntry(text: string): JsonlMessageEntry {
  return { uuid: 'a', parentUuid: null, type: 'assistant', sessionId: 'sess-1', timestamp: '', message: { role: 'assistant', content: text } }
}
function llmJson(obj: unknown, stop_reason = 'end_turn') {
  return { stop_reason, content: [{ type: 'text', text: JSON.stringify(obj) }] }
}
function memoryFile(id = 'conv-1'): string {
  return path.join(memoryDir, `consolidated-${id}.md`)
}

describe('consolidateConversation', () => {
  beforeEach(async () => {
    memoryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'consolidation-test-'))
    vi.clearAllMocks()
    markConsolidatedMock.mockReturnValue(true)
    getChatIntegrationMock.mockReturnValue({ agentSlug: 'agent-a' })
    getSessionMessagesMock.mockResolvedValue([userEntry('hi'), assistantEntry('hello')])
  })

  afterEach(async () => {
    await fs.promises.rm(memoryDir, { recursive: true, force: true })
  })

  it('parses, writes durable memory to the keyed path, and commits the recap', async () => {
    messagesCreate.mockResolvedValue(llmJson({ durableMemory: 'remember X', recap: 'we did X' }))

    await consolidateConversation(makeConversation())

    expect(messagesCreate).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(memoryFile(), 'utf8')).toBe('remember X')
    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', 'we did X')
  })

  it('skips entirely when already consolidated (no LLM call, no commit)', async () => {
    await consolidateConversation(makeConversation({ consolidatedAt: new Date() }))

    expect(getSessionMessagesMock).not.toHaveBeenCalled()
    expect(messagesCreate).not.toHaveBeenCalled()
    expect(markConsolidatedMock).not.toHaveBeenCalled()
  })

  it('returns without committing when the integration is gone', async () => {
    getChatIntegrationMock.mockReturnValue(null)

    await consolidateConversation(makeConversation())

    expect(messagesCreate).not.toHaveBeenCalled()
    expect(markConsolidatedMock).not.toHaveBeenCalled()
  })

  it('commits an empty fallback for an empty transcript without calling the model', async () => {
    getSessionMessagesMock.mockResolvedValue([])

    await consolidateConversation(makeConversation())

    expect(messagesCreate).not.toHaveBeenCalled()
    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', '')
    expect(fs.existsSync(memoryFile())).toBe(false)
  })

  it('commits a fallback on refusal (no throw, no memory write)', async () => {
    messagesCreate.mockResolvedValue({ stop_reason: 'refusal', content: [] })

    await expect(consolidateConversation(makeConversation())).resolves.toBeUndefined()

    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', '')
    expect(fs.existsSync(memoryFile())).toBe(false)
  })

  it('commits a fallback on max_tokens truncation rather than persisting partial JSON', async () => {
    messagesCreate.mockResolvedValue({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"durableMemory":"par' }] })

    await consolidateConversation(makeConversation())

    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', '')
    expect(fs.existsSync(memoryFile())).toBe(false)
  })

  it('commits a fallback when the model returns no text', async () => {
    messagesCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [] })

    await consolidateConversation(makeConversation())

    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', '')
  })

  it('commits a fallback when the output is not valid JSON', async () => {
    messagesCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json at all' }] })

    await consolidateConversation(makeConversation())

    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', '')
  })

  it('commits a fallback when JSON is missing a required field', async () => {
    messagesCreate.mockResolvedValue(llmJson({ recap: 'only a recap, no durableMemory' }))

    await consolidateConversation(makeConversation())

    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', '')
  })

  it('rethrows a transient model error so the sweep retries (does not commit)', async () => {
    messagesCreate.mockRejectedValue(new Error('network blip'))

    await expect(consolidateConversation(makeConversation())).rejects.toThrow('network blip')
    expect(markConsolidatedMock).not.toHaveBeenCalled()
  })

  it('truncates an over-cap transcript to the most-recent tail before the model call', async () => {
    const big = 'A'.repeat(500_000)
    getSessionMessagesMock.mockResolvedValue([userEntry(big), userEntry('RECENT_TAIL_MARKER')])
    messagesCreate.mockResolvedValue(llmJson({ durableMemory: '', recap: 'ok' }))

    await consolidateConversation(makeConversation())

    const prompt = messagesCreate.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('RECENT_TAIL_MARKER')
    expect(prompt).toContain('[earlier turns omitted]')
    expect(prompt.length).toBeLessThan(450_000)
  })

  it('does not write a memory file when durableMemory is empty, but still commits the recap', async () => {
    messagesCreate.mockResolvedValue(llmJson({ durableMemory: '   ', recap: 'just a recap' }))

    await consolidateConversation(makeConversation())

    expect(fs.existsSync(memoryFile())).toBe(false)
    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', 'just a recap')
  })

  it('overwrites the same keyed file on a second run (idempotent, not duplicated)', async () => {
    messagesCreate.mockResolvedValue(llmJson({ durableMemory: 'v1', recap: 'r1' }))
    await consolidateConversation(makeConversation())

    messagesCreate.mockResolvedValue(llmJson({ durableMemory: 'v2', recap: 'r2' }))
    await consolidateConversation(makeConversation())

    const files = fs.readdirSync(memoryDir).filter((f) => f.startsWith('consolidated-'))
    expect(files).toEqual(['consolidated-conv-1.md'])
    expect(fs.readFileSync(memoryFile(), 'utf8')).toBe('v2')
  })
})
