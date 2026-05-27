import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TransformedItem, TransformedMessage } from '@shared/lib/utils/message-transform'

// ============================================================================
// Mocks — must be declared before import
// ============================================================================

const mockReaddir = vi.fn()
const mockReadFile = vi.fn()

vi.mock('fs', () => ({
  default: {
    promises: {
      readdir: (...args: unknown[]) => mockReaddir(...args),
      readFile: (...args: unknown[]) => mockReadFile(...args),
    },
  },
  promises: {
    readdir: (...args: unknown[]) => mockReaddir(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
  },
}))

vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentSessionsDir: () => '/mock/sessions',
  // Stub other exports that agents.ts pulls in
  getSessionJsonlPath: vi.fn(),
  readFileOrNull: vi.fn(),
  readJsonlFile: vi.fn(),
  getAgentWorkspaceDir: vi.fn(),
}))

// Stub every heavy dependency that `agents.ts` imports so the module loads
// without side-effects.  Only the function under test matters.
vi.mock('@shared/lib/services/agent-service', () => ({
  listAgentsWithStatus: vi.fn(), createAgent: vi.fn(), getAgentWithStatus: vi.fn(),
  getAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(), agentExists: vi.fn(),
}))
vi.mock('@shared/lib/container/container-manager', () => ({ containerManager: {} }))
vi.mock('@shared/lib/container/message-persister', () => ({ messagePersister: {} }))
vi.mock('@shared/lib/services/session-service', () => ({
  listSessions: vi.fn(), updateSessionName: vi.fn(), registerSession: vi.fn(),
  getSessionMessagesWithCompact: vi.fn(), getSession: vi.fn(),
  getSessionMetadata: vi.fn(), updateSessionMetadata: vi.fn(),
  deleteSession: vi.fn(), removeMessage: vi.fn(), removeToolCall: vi.fn(),
}))
vi.mock('@shared/lib/services/secrets-service', () => ({
  listSecrets: vi.fn(), getSecret: vi.fn(), setSecret: vi.fn(),
  deleteSecret: vi.fn(), keyToEnvVar: vi.fn(), getSecretEnvVars: vi.fn(),
}))
vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  listScheduledTasks: vi.fn(), listPendingScheduledTasks: vi.fn(),
}))
vi.mock('@shared/lib/db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), delete: vi.fn(), update: vi.fn() },
}))
vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: {}, agentConnectedAccounts: {}, proxyAuditLog: {},
  remoteMcpServers: {}, agentRemoteMcps: {}, mcpAuditLog: {},
  agentAcl: {}, user: {},
}))
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(), and: vi.fn(), inArray: vi.fn(), desc: vi.fn(),
  count: vi.fn(), like: vi.fn(), or: vi.fn(),
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: vi.fn(() => false) }))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: vi.fn() }))
vi.mock('@shared/lib/account-providers', () => ({ getProvider: vi.fn() }))
vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveAnthropicApiKey: vi.fn(), getEffectiveModels: vi.fn(),
  getEffectiveAgentLimits: vi.fn(), getCustomEnvVars: vi.fn(), getSettings: vi.fn(),
}))
vi.mock('@shared/lib/proxy/token-store', () => ({ revokeProxyToken: vi.fn() }))
vi.mock('@shared/lib/services/skillset-service', () => ({
  getAgentSkillsWithStatus: vi.fn(), getDiscoverableSkills: vi.fn(),
  installSkillFromSkillset: vi.fn(), updateSkillFromSkillset: vi.fn(),
  createSkillPR: vi.fn(), getSkillPRInfo: vi.fn(), getSkillPublishInfo: vi.fn(),
  publishSkillToSkillset: vi.fn(), refreshAgentSkills: vi.fn(),
}))
vi.mock('@shared/lib/services/agent-template-service', () => ({
  listAgentTemplates: vi.fn(), getAgentTemplate: vi.fn(),
  createAgentFromTemplate: vi.fn(),
}))
vi.mock('@shared/lib/utils/retry', () => ({ withRetry: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }))
vi.mock('hono/streaming', () => ({ streamSSE: vi.fn() }))
vi.mock('@shared/lib/utils/message-transform', () => ({
  transformMessages: vi.fn(() => []),
  // Re-export types (they're erased at runtime, but the mock needs the shape)
}))
vi.mock('../middleware/auth', () => ({
  Authenticated: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  AgentRead: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  AgentUser: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  AgentAdmin: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}))

// Import after mocks
import { resolveInterruptedSubagents } from './agents'

// ============================================================================
// Test Fixtures
// ============================================================================

function makeAssistantMsg(toolCalls: TransformedMessage['toolCalls'], id = 'msg-1'): TransformedMessage {
  return {
    id,
    type: 'assistant',
    content: { text: '' },
    toolCalls,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }
}

function makeTaskToolCall(
  id: string,
  opts: { subagent?: TransformedMessage['toolCalls'][number]['subagent']; result?: string } = {}
): TransformedMessage['toolCalls'][number] {
  return {
    id,
    name: 'Task',
    input: { prompt: 'do something', description: 'test' },
    result: opts.result,
    subagent: opts.subagent,
  }
}

function makeRegularToolCall(id: string): TransformedMessage['toolCalls'][number] {
  return { id, name: 'Bash', input: { command: 'ls' }, result: 'file.txt' }
}

/** Helper to set up mockReadFile to return .meta.json content by filename */
function setupMetaFiles(metaByFile: Record<string, { toolUseId: string }>) {
  mockReadFile.mockImplementation((filePath: string) => {
    for (const [name, meta] of Object.entries(metaByFile)) {
      if (filePath.endsWith(name)) {
        return Promise.resolve(JSON.stringify(meta))
      }
    }
    return Promise.reject(new Error('ENOENT'))
  })
}

// ============================================================================
// Tests
// ============================================================================

describe('resolveInterruptedSubagents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // --------------------------------------------------------------------------
  // No-op cases
  // --------------------------------------------------------------------------

  it('does nothing when there are no Task tool calls', async () => {
    const items: TransformedItem[] = [
      makeAssistantMsg([makeRegularToolCall('tool-1')]),
    ]

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    // Should not even read the filesystem
    expect(mockReaddir).not.toHaveBeenCalled()
    // Tool call unchanged
    expect((items[0] as TransformedMessage).toolCalls[0].subagent).toBeUndefined()
  })

  it('does nothing when all Task tool calls already have subagent info', async () => {
    const items: TransformedItem[] = [
      makeAssistantMsg([
        makeTaskToolCall('tool-1', {
          result: 'done',
          subagent: { agentId: 'agent-abc', status: 'completed' },
        }),
      ]),
    ]

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    expect(mockReaddir).not.toHaveBeenCalled()
  })

  it('does nothing when there are no messages at all', async () => {
    await resolveInterruptedSubagents([], 'my-agent', 'session-1')
    expect(mockReaddir).not.toHaveBeenCalled()
  })

  it('does nothing when items only contain user messages and compact boundaries', async () => {
    const items: TransformedItem[] = [
      { id: 'u1', type: 'user', content: { text: 'hello' }, toolCalls: [], createdAt: new Date() },
      { id: 'b1', type: 'compact_boundary', summary: 'summary', trigger: 'auto', createdAt: new Date() },
    ]

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')
    expect(mockReaddir).not.toHaveBeenCalled()
  })

  // --------------------------------------------------------------------------
  // Subagents directory missing
  // --------------------------------------------------------------------------

  it('gracefully handles missing subagents directory', async () => {
    const tc = makeTaskToolCall('tool-1')
    const items: TransformedItem[] = [makeAssistantMsg([tc])]

    mockReaddir.mockRejectedValue(new Error('ENOENT'))

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    // Should not crash, and tool call stays unresolved
    expect(tc.subagent).toBeUndefined()
  })

  // --------------------------------------------------------------------------
  // Single interrupted subagent — the core scenario
  // --------------------------------------------------------------------------

  it('resolves a single interrupted Task tool call via .meta.json toolUseId', async () => {
    const tc = makeTaskToolCall('tool-1')
    const items: TransformedItem[] = [makeAssistantMsg([tc])]

    mockReaddir.mockResolvedValue(['agent-abc123.meta.json'])
    setupMetaFiles({ 'agent-abc123.meta.json': { toolUseId: 'tool-1' } })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    expect(tc.subagent).toEqual({
      agentId: 'abc123',
      status: 'cancelled',
    })
  })

  it('uses correct directory path based on agentSlug and sessionId', async () => {
    const tc = makeTaskToolCall('tool-1')
    const items: TransformedItem[] = [makeAssistantMsg([tc])]

    mockReaddir.mockResolvedValue(['agent-xyz.meta.json'])
    setupMetaFiles({ 'agent-xyz.meta.json': { toolUseId: 'tool-1' } })

    await resolveInterruptedSubagents(items, 'my-agent', 'sess-42')

    // getAgentSessionsDir returns '/mock/sessions', so the path should be:
    expect(mockReaddir).toHaveBeenCalledWith('/mock/sessions/sess-42/subagents')
  })

  // --------------------------------------------------------------------------
  // Multiple subagents — deterministic matching by toolUseId
  // --------------------------------------------------------------------------

  it('matches multiple interrupted Task calls to subagents by toolUseId', async () => {
    const tc1 = makeTaskToolCall('tool-1')
    const tc2 = makeTaskToolCall('tool-2')
    const items: TransformedItem[] = [
      makeAssistantMsg([tc1], 'msg-1'),
      makeAssistantMsg([tc2], 'msg-2'),
    ]

    mockReaddir.mockResolvedValue(['agent-second.meta.json', 'agent-first.meta.json'])
    setupMetaFiles({
      'agent-first.meta.json': { toolUseId: 'tool-1' },
      'agent-second.meta.json': { toolUseId: 'tool-2' },
    })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    // Deterministic matching: tc1 (tool-1) → agent-first, tc2 (tool-2) → agent-second
    expect(tc1.subagent).toEqual({ agentId: 'first', status: 'cancelled' })
    expect(tc2.subagent).toEqual({ agentId: 'second', status: 'cancelled' })
  })

  // --------------------------------------------------------------------------
  // Mix of resolved and unresolved
  // --------------------------------------------------------------------------

  it('skips already-resolved Task calls and only resolves unresolved ones', async () => {
    const resolvedTc = makeTaskToolCall('tool-1', {
      result: 'done',
      subagent: { agentId: 'already-resolved', status: 'completed' },
    })
    const unresolvedTc = makeTaskToolCall('tool-2')
    const items: TransformedItem[] = [
      makeAssistantMsg([resolvedTc], 'msg-1'),
      makeAssistantMsg([unresolvedTc], 'msg-2'),
    ]

    mockReaddir.mockResolvedValue([
      'agent-already-resolved.meta.json',
      'agent-new-one.meta.json',
    ])
    setupMetaFiles({
      'agent-already-resolved.meta.json': { toolUseId: 'tool-1' },
      'agent-new-one.meta.json': { toolUseId: 'tool-2' },
    })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    // Resolved one stays unchanged
    expect(resolvedTc.subagent).toEqual({ agentId: 'already-resolved', status: 'completed' })
    // Unresolved one gets matched via toolUseId
    expect(unresolvedTc.subagent).toEqual({ agentId: 'new-one', status: 'cancelled' })
  })

  it('excludes already-resolved agentIds from the meta.json scan', async () => {
    const resolvedTc = makeTaskToolCall('tool-1', {
      result: 'done',
      subagent: { agentId: 'already-resolved', status: 'completed' },
    })
    const unresolvedTc = makeTaskToolCall('tool-2')
    const items: TransformedItem[] = [
      makeAssistantMsg([resolvedTc, unresolvedTc]),
    ]

    mockReaddir.mockResolvedValue([
      'agent-already-resolved.meta.json',
      'agent-new-one.meta.json',
    ])
    setupMetaFiles({
      // already-resolved.meta.json should be skipped (agentId already known)
      'agent-already-resolved.meta.json': { toolUseId: 'tool-1' },
      'agent-new-one.meta.json': { toolUseId: 'tool-2' },
    })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    // readFile should NOT have been called for the already-resolved agent
    const readFileCalls = mockReadFile.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(readFileCalls.some((p: string) => p.includes('already-resolved'))).toBe(false)
    expect(unresolvedTc.subagent).toEqual({ agentId: 'new-one', status: 'cancelled' })
  })

  // --------------------------------------------------------------------------
  // Edge: unresolved calls with no matching meta.json
  // --------------------------------------------------------------------------

  it('leaves unresolved calls untouched when no meta.json matches their toolUseId', async () => {
    const tc1 = makeTaskToolCall('tool-1')
    const tc2 = makeTaskToolCall('tool-2')
    const tc3 = makeTaskToolCall('tool-3')
    const items: TransformedItem[] = [
      makeAssistantMsg([tc1, tc2, tc3]),
    ]

    // Only one meta.json exists and it maps to tool-2
    mockReaddir.mockResolvedValue(['agent-only-one.meta.json'])
    setupMetaFiles({ 'agent-only-one.meta.json': { toolUseId: 'tool-2' } })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    expect(tc1.subagent).toBeUndefined()
    expect(tc2.subagent).toEqual({ agentId: 'only-one', status: 'cancelled' })
    expect(tc3.subagent).toBeUndefined()
  })

  // --------------------------------------------------------------------------
  // Edge: more meta.json files than unresolved calls
  // --------------------------------------------------------------------------

  it('only resolves matching calls when more meta.json files than unresolved calls', async () => {
    const tc = makeTaskToolCall('tool-1')
    const items: TransformedItem[] = [makeAssistantMsg([tc])]

    mockReaddir.mockResolvedValue([
      'agent-aaa.meta.json',
      'agent-bbb.meta.json',
      'agent-ccc.meta.json',
    ])
    setupMetaFiles({
      'agent-aaa.meta.json': { toolUseId: 'tool-99' },
      'agent-bbb.meta.json': { toolUseId: 'tool-1' },
      'agent-ccc.meta.json': { toolUseId: 'tool-42' },
    })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    // Should match based on toolUseId, not position/order
    expect(tc.subagent).toEqual({ agentId: 'bbb', status: 'cancelled' })
  })

  // --------------------------------------------------------------------------
  // Non-.meta.json files in subagents directory
  // --------------------------------------------------------------------------

  it('ignores non-.meta.json files in the subagents directory', async () => {
    const tc = makeTaskToolCall('tool-1')
    const items: TransformedItem[] = [makeAssistantMsg([tc])]

    mockReaddir.mockResolvedValue([
      'README.md',
      '.DS_Store',
      'agent-fake.jsonl',
      'agent-real-one.meta.json',
    ])
    setupMetaFiles({
      'agent-real-one.meta.json': { toolUseId: 'tool-1' },
    })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    // Should only process .meta.json files
    expect(tc.subagent).toEqual({ agentId: 'real-one', status: 'cancelled' })
    // readFile should only be called for the .meta.json file
    expect(mockReadFile).toHaveBeenCalledTimes(1)
  })

  // --------------------------------------------------------------------------
  // readFile failure for a file
  // --------------------------------------------------------------------------

  it('skips .meta.json files whose readFile call fails', async () => {
    const tc = makeTaskToolCall('tool-1')
    const items: TransformedItem[] = [makeAssistantMsg([tc])]

    mockReaddir.mockResolvedValue(['agent-broken.meta.json', 'agent-good.meta.json'])
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.endsWith('agent-broken.meta.json')) {
        return Promise.reject(new Error('EACCES'))
      }
      return Promise.resolve(JSON.stringify({ toolUseId: 'tool-1' }))
    })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    expect(tc.subagent).toEqual({ agentId: 'good', status: 'cancelled' })
  })

  it('skips .meta.json files with invalid JSON', async () => {
    const tc = makeTaskToolCall('tool-1')
    const items: TransformedItem[] = [makeAssistantMsg([tc])]

    mockReaddir.mockResolvedValue(['agent-bad.meta.json', 'agent-good.meta.json'])
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.endsWith('agent-bad.meta.json')) {
        return Promise.resolve('not valid json{{{')
      }
      return Promise.resolve(JSON.stringify({ toolUseId: 'tool-1' }))
    })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    expect(tc.subagent).toEqual({ agentId: 'good', status: 'cancelled' })
  })

  it('skips .meta.json files without a toolUseId field', async () => {
    const tc = makeTaskToolCall('tool-1')
    const items: TransformedItem[] = [makeAssistantMsg([tc])]

    mockReaddir.mockResolvedValue(['agent-no-id.meta.json', 'agent-good.meta.json'])
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.endsWith('agent-no-id.meta.json')) {
        return Promise.resolve(JSON.stringify({ someOtherField: 'value' }))
      }
      return Promise.resolve(JSON.stringify({ toolUseId: 'tool-1' }))
    })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    expect(tc.subagent).toEqual({ agentId: 'good', status: 'cancelled' })
  })

  // --------------------------------------------------------------------------
  // Non-Task tool calls are not affected
  // --------------------------------------------------------------------------

  it('does not modify non-Task tool calls', async () => {
    const bashTc = makeRegularToolCall('bash-1')
    const taskTc = makeTaskToolCall('task-1')
    const items: TransformedItem[] = [
      makeAssistantMsg([bashTc, taskTc]),
    ]

    mockReaddir.mockResolvedValue(['agent-sub1.meta.json'])
    setupMetaFiles({ 'agent-sub1.meta.json': { toolUseId: 'task-1' } })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    expect(bashTc.subagent).toBeUndefined()
    expect(taskTc.subagent).toEqual({ agentId: 'sub1', status: 'cancelled' })
  })

  // --------------------------------------------------------------------------
  // Task tool call with result but no subagent (edge case)
  // --------------------------------------------------------------------------

  it('resolves Task calls that have a result but no subagent info', async () => {
    // This could happen if the tool result was written but without the agentId metadata
    const tc = makeTaskToolCall('tool-1', { result: 'some result' })
    const items: TransformedItem[] = [makeAssistantMsg([tc])]

    mockReaddir.mockResolvedValue(['agent-discovered.meta.json'])
    setupMetaFiles({ 'agent-discovered.meta.json': { toolUseId: 'tool-1' } })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    expect(tc.subagent).toEqual({ agentId: 'discovered', status: 'cancelled' })
  })

  // --------------------------------------------------------------------------
  // Empty subagents directory
  // --------------------------------------------------------------------------

  it('does nothing when subagents directory is empty', async () => {
    const tc = makeTaskToolCall('tool-1')
    const items: TransformedItem[] = [makeAssistantMsg([tc])]

    mockReaddir.mockResolvedValue([])

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    expect(tc.subagent).toBeUndefined()
  })

  // --------------------------------------------------------------------------
  // Multiple tool calls in a single message
  // --------------------------------------------------------------------------

  it('resolves multiple Task calls within a single assistant message', async () => {
    const tc1 = makeTaskToolCall('tool-1')
    const tc2 = makeTaskToolCall('tool-2')
    const items: TransformedItem[] = [
      makeAssistantMsg([makeRegularToolCall('bash-1'), tc1, makeRegularToolCall('bash-2'), tc2]),
    ]

    mockReaddir.mockResolvedValue(['agent-first.meta.json', 'agent-second.meta.json'])
    setupMetaFiles({
      'agent-first.meta.json': { toolUseId: 'tool-1' },
      'agent-second.meta.json': { toolUseId: 'tool-2' },
    })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    expect(tc1.subagent).toEqual({ agentId: 'first', status: 'cancelled' })
    expect(tc2.subagent).toEqual({ agentId: 'second', status: 'cancelled' })
  })

  // --------------------------------------------------------------------------
  // Agent tool calls (not just Task) are also resolved
  // --------------------------------------------------------------------------

  it('resolves Agent tool calls the same as Task tool calls', async () => {
    const tc: TransformedMessage['toolCalls'][number] = {
      id: 'agent-call-1',
      name: 'Agent',
      input: { prompt: 'do something', description: 'test' },
    }
    const items: TransformedItem[] = [makeAssistantMsg([tc])]

    mockReaddir.mockResolvedValue(['agent-sub1.meta.json'])
    setupMetaFiles({ 'agent-sub1.meta.json': { toolUseId: 'agent-call-1' } })

    await resolveInterruptedSubagents(items, 'my-agent', 'session-1')

    expect(tc.subagent).toEqual({ agentId: 'sub1', status: 'cancelled' })
  })
})
