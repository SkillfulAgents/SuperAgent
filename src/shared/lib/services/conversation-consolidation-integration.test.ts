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

function memoryResponse(durableMemory: string, recap: string) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ durableMemory, recap }) }] }
}

describe('consolidateConversation durable-memory integration', () => {
  beforeEach(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'consolidation-int-'))
    process.env.SUPERAGENT_DATA_DIR = dataDir
    vi.clearAllMocks()
    markConsolidatedMock.mockReturnValue(true)
    messagesCreate.mockResolvedValue(memoryResponse('User ships on Fridays.', 'We planned the Friday release.'))
  })

  afterEach(async () => {
    delete process.env.SUPERAGENT_DATA_DIR
    await fs.promises.rm(dataDir, { recursive: true, force: true })
  })

  it('writes durable memory to the real persistent memory path from a real JSONL transcript', async () => {
    await writeJsonl('agent-int', 'sess-int-1', [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'sess-int-1', timestamp: 't1', message: { role: 'user', content: 'We should ship on Friday.' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'sess-int-1', timestamp: 't2', message: { role: 'assistant', content: 'Agreed, Friday it is.' } },
    ])

    await consolidateConversation(conversation())

    const memFile = path.join(getAgentMemoryDir('agent-int'), 'consolidated-conv-int-1.md')
    expect(fs.existsSync(memFile)).toBe(true)
    expect(fs.readFileSync(memFile, 'utf8')).toBe('User ships on Fridays.')
    // The file lands at the persistent path the agent reads (memory_recall).
    expect(memFile).toContain(path.join('workspace', '.claude', 'projects', '-workspace', 'memory'))

    // The real transcript was serialized into the prompt as Role: text turns.
    const prompt = messagesCreate.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('User: We should ship on Friday.')
    expect(prompt).toContain('Assistant: Agreed, Friday it is.')

    expect(markConsolidatedMock).toHaveBeenCalledWith('conv-int-1', 'We planned the Friday release.')
  })

  it('overwrites the same keyed file on a second run (idempotent, not duplicated)', async () => {
    await writeJsonl('agent-int', 'sess-int-1', [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'sess-int-1', timestamp: 't1', message: { role: 'user', content: 'hi' } },
    ])

    await consolidateConversation(conversation())
    messagesCreate.mockResolvedValue(memoryResponse('v2 memory', 'r2'))
    await consolidateConversation(conversation())

    const memDir = getAgentMemoryDir('agent-int')
    const files = fs.readdirSync(memDir).filter((f) => f.startsWith('consolidated-'))
    expect(files).toEqual(['consolidated-conv-int-1.md'])
    expect(fs.readFileSync(path.join(memDir, 'consolidated-conv-int-1.md'), 'utf8')).toBe('v2 memory')
  })
})
