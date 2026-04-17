import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import * as os from 'os'
import { promises as fs } from 'fs'
import type { ContainerClient, StreamMessage } from './types'

// ----- Mocks for external dependencies (real fs is intentionally NOT mocked) -----

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  createScheduledTask: vi.fn(),
}))
vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
}))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerSessionComplete: vi.fn(() => Promise.resolve()),
    triggerSessionWaitingInput: vi.fn(() => Promise.resolve()),
  },
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  VALID_SCRIPT_TYPES: { darwin: ['applescript', 'shell'], linux: ['shell'], win32: ['powershell'] },
}))
vi.mock('@shared/lib/computer-use/permission-manager', () => ({
  computerUsePermissionManager: {
    checkPermission: vi.fn(() => 'prompt_needed'),
    getGrabbedApp: vi.fn(() => undefined),
    setGrabbedApp: vi.fn(),
    clearGrabbedApp: vi.fn(),
    consumeOnceGrant: vi.fn(),
  },
}))
vi.mock('@shared/lib/computer-use/types', () => ({
  getRequiredPermissionLevel: vi.fn(() => 'use_application'),
  resolveTargetApp: vi.fn(() => undefined),
  READ_ONLY_METHODS: new Set(['apps', 'windows', 'status', 'displays', 'permissions']),
  TIMED_GRANT_DURATION_MS: 15 * 60 * 1000,
}))
vi.mock('@shared/lib/computer-use/executor', () => ({
  resolveAppFromWindowRef: vi.fn(() => undefined),
}))
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  createWebhookTrigger: vi.fn(() => Promise.resolve('trigger_new_id')),
  listActiveWebhookTriggers: vi.fn(() => Promise.resolve([])),
  cancelWebhookTriggerWithCleanup: vi.fn(() => Promise.resolve(true)),
}))
vi.mock('@shared/lib/composio/triggers', () => ({
  getAvailableTriggers: vi.fn(() => Promise.resolve([])),
  enableComposioTrigger: vi.fn(() => Promise.resolve('composio_trigger_id')),
  deleteComposioTrigger: vi.fn(() => Promise.resolve()),
}))
vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: vi.fn(() => true),
}))
vi.mock('@shared/lib/services/timezone-resolver', () => ({
  resolveTimezoneForAgent: vi.fn(() => Promise.resolve('UTC')),
}))
vi.mock('@shared/lib/analytics/server-analytics', () => ({
  trackServerEvent: vi.fn(),
}))
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({ connectedAccounts: {} }))
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }))

// getAgentSessionsDir is mocked per-test to point at the tmpDir root
const mockSessionsDir: { value: string } = { value: '/nonexistent' }
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentSessionsDir: (_agentSlug: string) => mockSessionsDir.value,
}))

// ----- Fixture loading -----

const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'sequential-subagent-reset')

interface FixtureMeta {
  sessionId: string
  agentSlug: string
  parentToolIdA: string
  parentToolIdB: string
  agentIdA: string
}

async function loadFixture(): Promise<{
  meta: FixtureMeta
  streamEntries: Array<{ t: number; message: StreamMessage }>
  fsSnapshotFiles: Array<{ name: string; content: Buffer; mtimeMs: number; atimeMs: number }>
}> {
  const meta = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, 'metadata.json'), 'utf8'))
  const raw = await fs.readFile(path.join(FIXTURE_DIR, 'stream-input-run2.jsonl'), 'utf8')
  const streamEntries = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))

  const snapDir = path.join(FIXTURE_DIR, 'fs-snapshot')
  const names = await fs.readdir(snapDir)
  const fsSnapshotFiles = []
  for (const name of names) {
    const p = path.join(snapDir, name)
    const stat = await fs.stat(p)
    if (!stat.isFile()) continue
    fsSnapshotFiles.push({
      name,
      content: await fs.readFile(p),
      mtimeMs: stat.mtimeMs,
      atimeMs: stat.atimeMs,
    })
  }
  return { meta, streamEntries, fsSnapshotFiles }
}

// ----- Mock container client that replays captured messages -----

function createReplayClient(): {
  client: ContainerClient
  send: (message: StreamMessage) => void
} {
  let callback: ((message: StreamMessage) => void) | null = null
  const client = {
    subscribeToStream: vi.fn((_sid: string, cb: (message: StreamMessage) => void) => {
      callback = cb
      return { unsubscribe: vi.fn(), ready: Promise.resolve() }
    }),
    start: vi.fn(),
    stop: vi.fn(),
    stopSync: vi.fn(),
    getInfoFromRuntime: vi.fn(),
    getInfo: vi.fn(),
    fetch: vi.fn(),
    waitForHealthy: vi.fn(),
    isHealthy: vi.fn(),
    getStats: vi.fn(),
    createSession: vi.fn(),
    getSession: vi.fn(() => Promise.resolve(null)),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    getMessages: vi.fn(),
    interruptSession: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as ContainerClient
  return {
    client,
    send: (m) => callback?.(m),
  }
}

// ----- The harness itself -----

describe('subagent routing replay — sequential subagents across state reset', () => {
  let tmpDir: string
  let sseEvents: Array<Record<string, unknown>>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-replay-'))
    sseEvents = []
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    vi.clearAllMocks()
  })

  it('reproduces the bug: B gets A\'s agentId due to FIFO discovery on stale file', async () => {
    const { meta, streamEntries, fsSnapshotFiles } = await loadFixture()

    // Arrange: set up tmpDir to mirror the FS state at moment of run-2 subscribe
    const sessionsRoot = path.join(tmpDir, 'sessions')
    const subagentsDir = path.join(sessionsRoot, meta.sessionId, 'subagents')
    await fs.mkdir(subagentsDir, { recursive: true })
    for (const f of fsSnapshotFiles) {
      const p = path.join(subagentsDir, f.name)
      await fs.writeFile(p, f.content)
      await fs.utimes(p, new Date(f.atimeMs), new Date(f.mtimeMs))
    }
    mockSessionsDir.value = sessionsRoot

    // Import the persister AFTER mocks are configured.
    // message-persister is a module-level singleton, so import fresh per test.
    vi.resetModules()
    const { messagePersister } = await import('./message-persister')
    const { client, send } = createReplayClient()

    // Collect SSE events
    const cleanup = messagePersister.addSSEClient(meta.sessionId, (data) => {
      sseEvents.push(data as Record<string, unknown>)
    })

    // Subscribe (mirrors what happens on app launch / session resume)
    await messagePersister.subscribeToSession(meta.sessionId, client, meta.sessionId, meta.agentSlug)

    // Replay the captured stream
    for (const entry of streamEntries) {
      send(entry.message)
      // Yield to the microtask queue so async FS discovery can run
      await new Promise((r) => setImmediate(r))
    }

    // Give any final async discovery a chance to complete
    await new Promise((r) => setTimeout(r, 100))

    cleanup()
    messagePersister.unsubscribeFromSession(meta.sessionId)

    // ----- Assertions -----

    // Filter subagent_updated broadcasts by parentToolId
    const bEvents = sseEvents.filter(
      (e) => e['type'] === 'subagent_updated' && e['parentToolId'] === meta.parentToolIdB
    )
    expect(bEvents.length).toBeGreaterThan(0)

    const bAgentIds = new Set(
      bEvents.map((e) => e['agentId']).filter((id): id is string => typeof id === 'string')
    )

    // The bug: B's subagent_updated events reference A's agentId
    expect(bAgentIds).not.toContain(meta.agentIdA)
    // And B should have only one distinct agentId (its own), not multiple
    expect(bAgentIds.size).toBeLessThanOrEqual(1)
  })
})
