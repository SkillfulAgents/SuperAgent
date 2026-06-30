import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let memoryDir: string
let apiKeyConfigured = true
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
  getActiveLlmProvider: () => ({
    getDefaultModel: () => 'sonnet',
    getApiKeyStatus: () => ({ isConfigured: apiKeyConfigured }),
  }),
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
interface MemoryEntry { name: string; description: string; type: string; body: string }
function llmResult(memories: MemoryEntry[], recap: string, stop_reason = 'end_turn', raw?: string) {
  const text = raw ?? JSON.stringify({ memories, recap })
  return { stop_reason, content: [{ type: 'text', text }] }
}
function memFile(slug: string): string {
  return path.join(memoryDir, `${slug}.md`)
}
function readIndex(): string {
  try { return fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8') } catch { return '' }
}

describe('consolidateConversation', () => {
  beforeEach(async () => {
    memoryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'consolidation-test-'))
    apiKeyConfigured = true
    vi.clearAllMocks()
    markConsolidatedMock.mockReturnValue(true)
    getChatIntegrationMock.mockReturnValue({ agentSlug: 'agent-a' })
    getSessionMessagesMock.mockResolvedValue([userEntry('hi'), assistantEntry('hello')])
  })

  afterEach(async () => {
    await fs.promises.rm(memoryDir, { recursive: true, force: true })
  })

  it('writes each memory as a frontmatter file + MEMORY.md pointer, and commits the recap', async () => {
    messagesCreate.mockResolvedValue(llmResult(
      [{ name: 'testing-preferences', description: 'wants long silent tasks finished fully', type: 'feedback', body: 'Jeremy prefers terse replies.' }],
      'we did X',
    ))

    await consolidateConversation(makeConversation())

    const file = fs.readFileSync(memFile('testing-preferences'), 'utf8')
    expect(file).toContain('name: testing-preferences')
    expect(file).toContain('type: feedback')
    expect(file).toContain('Jeremy prefers terse replies.')

    expect(readIndex()).toContain('](testing-preferences.md)')
    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', 'we did X')
  })

  it('feeds the existing MEMORY.md index to the model and preserves unrelated pointers on upsert', async () => {
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '- [Other Memory](other-memory.md) - unrelated\n')
    messagesCreate.mockResolvedValue(llmResult(
      [{ name: 'new-fact', description: 'a new fact', type: 'user', body: 'body' }],
      'r',
    ))

    await consolidateConversation(makeConversation())

    const prompt = messagesCreate.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('- [Other Memory](other-memory.md) - unrelated')

    const index = readIndex()
    expect(index).toContain('](other-memory.md)') // preserved
    expect(index).toContain('](new-fact.md)') // added
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
    expect(fs.existsSync(path.join(memoryDir, 'MEMORY.md'))).toBe(false)
  })

  it('commits a fallback on refusal (no throw, no memory write)', async () => {
    messagesCreate.mockResolvedValue({ stop_reason: 'refusal', content: [] })
    await expect(consolidateConversation(makeConversation())).resolves.toBeUndefined()
    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', '')
    expect(fs.existsSync(path.join(memoryDir, 'MEMORY.md'))).toBe(false)
  })

  it('commits a fallback on max_tokens truncation', async () => {
    messagesCreate.mockResolvedValue({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"memories":[' }] })
    await consolidateConversation(makeConversation())
    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', '')
  })

  it('commits a fallback when the output is not valid JSON', async () => {
    messagesCreate.mockResolvedValue(llmResult([], '', 'end_turn', 'not json at all'))
    await consolidateConversation(makeConversation())
    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', '')
  })

  it('tolerates a ```json fenced response (does not fall back)', async () => {
    const fenced = '```json\n' + JSON.stringify({ memories: [{ name: 'fact', description: 'd', type: 'user', body: 'b' }], recap: 'r' }) + '\n```'
    messagesCreate.mockResolvedValue(llmResult([], '', 'end_turn', fenced))
    await consolidateConversation(makeConversation())
    expect(fs.existsSync(memFile('fact'))).toBe(true)
    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', 'r')
  })

  it('sanitizes a malicious memory name into a safe slug (no path escape)', async () => {
    messagesCreate.mockResolvedValue(llmResult(
      [{ name: '../../etc/passwd', description: 'd', type: 'user', body: 'b' }],
      'r',
    ))
    await consolidateConversation(makeConversation())
    // Slug collapses to a safe in-dir filename; nothing escapes memoryDir.
    expect(fs.existsSync(memFile('etc-passwd'))).toBe(true)
    expect(fs.readdirSync(memoryDir).every((f) => !f.includes('..') && !f.includes('/'))).toBe(true)
  })

  it('skips a memory whose name sanitizes to nothing', async () => {
    messagesCreate.mockResolvedValue(llmResult(
      [{ name: '!!!', description: 'd', type: 'user', body: 'b' }],
      'r',
    ))
    await consolidateConversation(makeConversation())
    expect(fs.readdirSync(memoryDir).filter((f) => f !== 'MEMORY.md')).toEqual([])
    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', 'r')
  })

  it('writes no files for an empty memories array but still commits the recap', async () => {
    messagesCreate.mockResolvedValue(llmResult([], 'just a recap'))
    await consolidateConversation(makeConversation())
    expect(fs.existsSync(path.join(memoryDir, 'MEMORY.md'))).toBe(false)
    expect(fs.readdirSync(memoryDir)).toEqual([])
    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', 'just a recap')
  })

  it('dedupes by name across runs (same slug overwrites, one pointer)', async () => {
    messagesCreate.mockResolvedValue(llmResult([{ name: 'pref', description: 'd1', type: 'user', body: 'v1' }], 'r1'))
    await consolidateConversation(makeConversation())

    messagesCreate.mockResolvedValue(llmResult([{ name: 'pref', description: 'd2', type: 'user', body: 'v2' }], 'r2'))
    await consolidateConversation(makeConversation())

    const files = fs.readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    expect(files).toEqual(['pref.md'])
    expect(fs.readFileSync(memFile('pref'), 'utf8')).toContain('v2')
    // exactly one pointer line for pref.md
    const pointers = readIndex().split('\n').filter((l) => l.includes('](pref.md)'))
    expect(pointers).toHaveLength(1)
  })

  it('skips quietly when no LLM key is configured (no transcript read, no commit)', async () => {
    apiKeyConfigured = false
    await consolidateConversation(makeConversation())
    expect(getSessionMessagesMock).not.toHaveBeenCalled()
    expect(messagesCreate).not.toHaveBeenCalled()
    expect(markConsolidatedMock).not.toHaveBeenCalled()
  })

  it('commits an empty fallback on a deterministic request error (e.g. 400 prompt-too-long / unsupported output_config)', async () => {
    messagesCreate.mockRejectedValue(Object.assign(new Error('prompt is too long'), { status: 400 }))
    await expect(consolidateConversation(makeConversation())).resolves.toBeUndefined()
    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-1', '')
  })

  it('rethrows a transient error (e.g. 529 overloaded) so the sweep retries (no commit)', async () => {
    messagesCreate.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }))
    await expect(consolidateConversation(makeConversation())).rejects.toThrow('overloaded')
    expect(markConsolidatedMock).not.toHaveBeenCalled()
  })

  it('rethrows a network error with no status so the sweep retries', async () => {
    messagesCreate.mockRejectedValue(new Error('socket hang up'))
    await expect(consolidateConversation(makeConversation())).rejects.toThrow('socket hang up')
    expect(markConsolidatedMock).not.toHaveBeenCalled()
  })

  it('truncates an over-cap transcript to the most-recent tail before the model call', async () => {
    const big = 'A'.repeat(500_000)
    getSessionMessagesMock.mockResolvedValue([userEntry(big), userEntry('RECENT_TAIL_MARKER')])
    messagesCreate.mockResolvedValue(llmResult([], 'ok'))
    await consolidateConversation(makeConversation())
    const prompt = messagesCreate.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('RECENT_TAIL_MARKER')
    expect(prompt).toContain('[earlier turns omitted]')
    expect(prompt.length).toBeLessThan(450_000)
  })
})
