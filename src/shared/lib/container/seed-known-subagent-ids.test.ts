import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import * as os from 'os'
import { promises as fs } from 'fs'

// Minimal mocks so message-persister can be imported (real fs stays real).
vi.mock('@shared/lib/services/scheduled-task-service', () => ({ createScheduledTask: vi.fn() }))
vi.mock('@shared/lib/services/session-service', () => ({ updateSessionMetadata: vi.fn(() => Promise.resolve()) }))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerSessionComplete: vi.fn(() => Promise.resolve()),
    triggerSessionWaitingInput: vi.fn(() => Promise.resolve()),
  },
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  VALID_SCRIPT_TYPES: { darwin: [], linux: [], win32: [] },
}))
vi.mock('@shared/lib/computer-use/permission-manager', () => ({
  computerUsePermissionManager: {
    checkPermission: vi.fn(() => 'prompt_needed'),
    getGrabbedApp: vi.fn(),
    setGrabbedApp: vi.fn(),
    clearGrabbedApp: vi.fn(),
    consumeOnceGrant: vi.fn(),
  },
}))
vi.mock('@shared/lib/computer-use/types', () => ({
  getRequiredPermissionLevel: vi.fn(() => 'use_application'),
  resolveTargetApp: vi.fn(() => undefined),
  READ_ONLY_METHODS: new Set(),
  TIMED_GRANT_DURATION_MS: 0,
}))
vi.mock('@shared/lib/computer-use/executor', () => ({ resolveAppFromWindowRef: vi.fn() }))
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  createWebhookTrigger: vi.fn(() => Promise.resolve('')),
  listActiveWebhookTriggers: vi.fn(() => Promise.resolve([])),
  cancelWebhookTriggerWithCleanup: vi.fn(() => Promise.resolve(true)),
}))
vi.mock('@shared/lib/composio/triggers', () => ({
  getAvailableTriggers: vi.fn(() => Promise.resolve([])),
  enableComposioTrigger: vi.fn(() => Promise.resolve('')),
  deleteComposioTrigger: vi.fn(() => Promise.resolve()),
}))
vi.mock('@shared/lib/composio/client', () => ({ isPlatformComposioActive: vi.fn(() => true) }))
vi.mock('@shared/lib/services/timezone-resolver', () => ({ resolveTimezoneForAgent: vi.fn(() => Promise.resolve('UTC')) }))
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({ connectedAccounts: {} }))
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }))

const sessionsRoot: { value: string } = { value: '/nonexistent' }
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentSessionsDir: (_agentSlug: string) => sessionsRoot.value,
}))

describe('seedKnownSubagentIds', () => {
  let tmpDir: string
  let seedKnownSubagentIds: (agentSlug: string | undefined, sessionId: string) => Set<string>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-test-'))
    sessionsRoot.value = tmpDir
    vi.resetModules()
    seedKnownSubagentIds = (await import('./message-persister')).seedKnownSubagentIds
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  async function makeSubagentsDir(sessionId: string, files: string[]): Promise<void> {
    const dir = path.join(tmpDir, sessionId, 'subagents')
    await fs.mkdir(dir, { recursive: true })
    for (const f of files) await fs.writeFile(path.join(dir, f), '')
  }

  it('returns empty set when agentSlug is undefined', () => {
    expect(seedKnownSubagentIds(undefined, 'any-session')).toEqual(new Set())
  })

  it('returns empty set when subagents dir does not exist', () => {
    expect(seedKnownSubagentIds('agent', 'no-such-session')).toEqual(new Set())
  })

  it('returns empty set for an empty subagents dir', async () => {
    await makeSubagentsDir('session-1', [])
    expect(seedKnownSubagentIds('agent', 'session-1')).toEqual(new Set())
  })

  it('extracts agentIds from agent-*.jsonl files', async () => {
    await makeSubagentsDir('session-2', ['agent-abc123.jsonl', 'agent-def456.jsonl'])
    expect(seedKnownSubagentIds('agent', 'session-2')).toEqual(new Set(['abc123', 'def456']))
  })

  it('ignores non-matching files (meta.json sidecars, arbitrary files)', async () => {
    await makeSubagentsDir('session-3', [
      'agent-abc123.jsonl',
      'agent-abc123.meta.json',
      'random.txt',
      'agent-no-extension',
      'not-an-agent.jsonl',
    ])
    expect(seedKnownSubagentIds('agent', 'session-3')).toEqual(new Set(['abc123']))
  })

  it('does not throw on filesystem errors', async () => {
    // Create a file where the subagents dir should be — readdir will error
    await fs.mkdir(path.join(tmpDir, 'session-4'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'session-4', 'subagents'), 'not a directory')
    expect(() => seedKnownSubagentIds('agent', 'session-4')).not.toThrow()
    expect(seedKnownSubagentIds('agent', 'session-4')).toEqual(new Set())
  })
})
