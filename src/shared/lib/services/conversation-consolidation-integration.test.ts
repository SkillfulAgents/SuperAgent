import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Integration test: exercises the REAL durable-memory write and the REAL session
// transcript read against a temp SUPERAGENT_DATA_DIR. Only the LLM client and the
// DB commit are faked — file I/O is real, so this proves memory actually lands at
// the persistent path the agent reads.

let dataDir: string
const messagesCreate = vi.fn()
const markConsolidatedMock = vi.fn((..._args: unknown[]) => true)

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: () => ({ agentSlug: 'agent-int' }),
}))
vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  markConversationConsolidated: (...args: unknown[]) => markConsolidatedMock(...args),
}))
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({
    getApiKeyStatus: () => ({ isConfigured: true }),
  }),
  resolveActiveProviderModel: () => 'claude-sonnet-4-6',
}))
vi.mock('@shared/lib/services/chat-integration-access-service', () => ({ isChatAllowed: () => true }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('@shared/lib/llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({ messages: { create: messagesCreate } }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extractTextFromLlmResponse: (resp: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = resp?.content?.find?.((x: any) => x.type === 'text')
    return b?.text?.trim() || null
  },
}))

import { consolidateConversation } from './conversation-consolidation-service'
import { getAgentMemoryDir, getSessionJsonlPath } from '@shared/lib/utils/file-storage'
import type { ChatIntegrationSession } from '../db/schema'

function conversation(over: Partial<ChatIntegrationSession> = {}): ChatIntegrationSession {
  const now = new Date()
  return {
    id: 'conv-int-1',
    integrationId: 'int-int-1',
    externalChatId: 'chat-int-1',
    sessionId: 'sess-int-1',
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

async function writeJsonl(slug: string, sessionId: string, entries: object[]): Promise<void> {
  const file = getSessionJsonlPath(slug, sessionId)
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}

interface Mem { name: string; description: string; type: string; body: string }
function memoryResponse(memories: Mem[], recap: string) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ memories, recap }) }] }
}

describe('consolidateConversation durable-memory integration', () => {
  beforeEach(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'consolidation-int-'))
    process.env.SUPERAGENT_DATA_DIR = dataDir
    vi.clearAllMocks()
    markConsolidatedMock.mockReturnValue(true)
    messagesCreate.mockResolvedValue(memoryResponse(
      [{ name: 'ships-on-fridays', description: 'ships on Fridays', type: 'user', body: 'User ships on Fridays.' }],
      'We planned the Friday release.',
    ))
  })

  afterEach(async () => {
    delete process.env.SUPERAGENT_DATA_DIR
    await fs.promises.rm(dataDir, { recursive: true, force: true })
  })

  it('writes a discoverable memory (file + MEMORY.md pointer) at the real persistent path from a real JSONL transcript', async () => {
    await writeJsonl('agent-int', 'sess-int-1', [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'sess-int-1', timestamp: 't1', message: { role: 'user', content: 'We should ship on Friday.' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'sess-int-1', timestamp: 't2', message: { role: 'assistant', content: 'Agreed, Friday it is.' } },
    ])

    await consolidateConversation(conversation())

    const memDir = getAgentMemoryDir('agent-int')
    const memFile = path.join(memDir, 'ships-on-fridays.md')
    expect(fs.existsSync(memFile)).toBe(true)
    const content = fs.readFileSync(memFile, 'utf8')
    expect(content).toContain('name: ships-on-fridays')
    expect(content).toContain('User ships on Fridays.')
    // Discoverable via the index, at the persistent path the agent reads (memory_recall).
    expect(fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8')).toContain('](ships-on-fridays.md)')
    expect(memDir).toContain(path.join('workspace', '.claude', 'projects', '-workspace', 'memory'))

    // The real transcript was serialized into the prompt as Role: text turns.
    const prompt = messagesCreate.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('User: We should ship on Friday.')
    expect(prompt).toContain('Assistant: Agreed, Friday it is.')

    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-int-1', 'We planned the Friday release.')
  })

  it('serializes ContentBlock[] turns (text + tool_use + tool_result) that real sessions actually produce', async () => {
    await writeJsonl('agent-int', 'sess-int-1', [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'sess-int-1', timestamp: 't1', message: { role: 'user', content: 'Run the build' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'sess-int-1', timestamp: 't2', message: { role: 'assistant', content: [
        { type: 'text', text: 'Running the build now.' },
        { type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'npm run build' } },
      ] } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 'sess-int-1', timestamp: 't3', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'build ok' },
      ] } },
    ])
    messagesCreate.mockResolvedValue(memoryResponse([], 'recap'))

    await consolidateConversation(conversation())

    // The block-array branch must produce a non-empty transcript (model IS called,
    // not the empty-transcript terminal fallback).
    expect(messagesCreate).toHaveBeenCalledTimes(1)
    const prompt = messagesCreate.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('Running the build now.')
    expect(prompt).toContain('[tool: bash]')
  })
})
