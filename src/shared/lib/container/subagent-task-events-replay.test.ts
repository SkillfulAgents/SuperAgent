import { describe, it, expect, afterEach, vi } from 'vitest'
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

const mockSessionsDir: { value: string } = { value: '/nonexistent' }
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentSessionsDir: (_agentSlug: string) => mockSessionsDir.value,
}))

// ----- Fixture loading -----

interface SubagentMeta {
  parentToolId: string
  taskId: string
  agentId: string
  subagentType: string
  description: string
}

interface FixtureMeta {
  sessionId: string
  agentSlug: string
  description: string
  subagents: SubagentMeta[]
  taskProgressCount?: number
  totalEntries: number
}

async function loadFixture(fixtureName: string): Promise<{
  meta: FixtureMeta
  streamEntries: Array<{ t: number; message: StreamMessage }>
  fsSnapshotFiles: Array<{ name: string; content: Buffer; mtimeMs: number; atimeMs: number }>
}> {
  const fixtureDir = path.join(__dirname, '__fixtures__', fixtureName)
  const meta = JSON.parse(await fs.readFile(path.join(fixtureDir, 'metadata.json'), 'utf8'))
  const raw = await fs.readFile(path.join(fixtureDir, 'stream-input.jsonl'), 'utf8')
  const streamEntries = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))

  const snapDir = path.join(fixtureDir, 'fs-snapshot')
  const fsSnapshotFiles: Array<{ name: string; content: Buffer; mtimeMs: number; atimeMs: number }> = []
  try {
    const names = await fs.readdir(snapDir)
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
  } catch {
    // No fs-snapshot directory
  }
  return { meta, streamEntries, fsSnapshotFiles }
}

// ----- Mock container client -----

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

// ----- Helper to replay a fixture through MessagePersister and collect SSE events -----

async function replayFixture(fixtureName: string): Promise<{
  meta: FixtureMeta
  sseEvents: Array<Record<string, unknown>>
}> {
  const { meta, streamEntries, fsSnapshotFiles } = await loadFixture(fixtureName)

  // Set up tmpDir with FS snapshot
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-events-replay-'))
  const sessionsRoot = path.join(tmpDir, 'sessions')
  const subagentsDir = path.join(sessionsRoot, meta.sessionId, 'subagents')
  await fs.mkdir(subagentsDir, { recursive: true })
  for (const f of fsSnapshotFiles) {
    const p = path.join(subagentsDir, f.name)
    await fs.writeFile(p, f.content)
    await fs.utimes(p, new Date(f.atimeMs), new Date(f.mtimeMs))
  }
  mockSessionsDir.value = sessionsRoot

  // Fresh import to get a clean singleton
  vi.resetModules()
  const { messagePersister } = await import('./message-persister')
  const { client, send } = createReplayClient()

  const sseEvents: Array<Record<string, unknown>> = []
  const cleanup = messagePersister.addSSEClient(meta.sessionId, (data) => {
    sseEvents.push(data as Record<string, unknown>)
  })

  await messagePersister.subscribeToSession(meta.sessionId, client, meta.sessionId, meta.agentSlug)

  // Replay
  for (const entry of streamEntries) {
    send(entry.message)
    await new Promise((r) => setImmediate(r))
  }

  // Let async discovery complete
  await new Promise((r) => setTimeout(r, 200))

  cleanup()
  messagePersister.unsubscribeFromSession(meta.sessionId)

  // Clean up tmpDir
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})

  return { meta, sseEvents }
}

// =====================================================================
// Tests
// =====================================================================

describe('subagent task_started / task_progress replay harness', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('parallel subagents', () => {
    it('broadcasts subagent_started with subagentType and description for both agents', async () => {
      const { meta, sseEvents } = await replayFixture('parallel-subagents')

      const startedEvents = sseEvents.filter((e) => e['type'] === 'subagent_started')

      // Should have one subagent_started per subagent
      expect(startedEvents).toHaveLength(2)

      for (const sub of meta.subagents) {
        const ev = startedEvents.find((e) => e['parentToolId'] === sub.parentToolId)
        expect(ev).toBeDefined()
        expect(ev!['subagentType']).toBe(sub.subagentType)
        expect(ev!['description']).toBe(sub.description)
        expect(ev!['taskId']).toBe(sub.taskId)
      }
    })

    it('broadcasts subagent_progress with parentToolId, usage, and lastToolName', async () => {
      const { meta, sseEvents } = await replayFixture('parallel-subagents')

      const progressEvents = sseEvents.filter((e) => e['type'] === 'subagent_progress')

      // Every progress event should have parentToolId mapped to a known subagent
      const knownToolIds = new Set(meta.subagents.map((s) => s.parentToolId))
      for (const ev of progressEvents) {
        expect(knownToolIds).toContain(ev['parentToolId'])
        expect(ev['usage']).toBeDefined()
        expect((ev['usage'] as Record<string, unknown>)['total_tokens']).toBeGreaterThan(0)
      }

      // Both subagents should have progress events
      const toolIdsWithProgress = new Set(progressEvents.map((e) => e['parentToolId']))
      for (const sub of meta.subagents) {
        expect(toolIdsWithProgress).toContain(sub.parentToolId)
      }
    })

    it('completes both subagents with correct agentIds', async () => {
      const { meta, sseEvents } = await replayFixture('parallel-subagents')

      const completedEvents = sseEvents.filter((e) => e['type'] === 'subagent_completed')
      expect(completedEvents).toHaveLength(2)

      for (const sub of meta.subagents) {
        const ev = completedEvents.find((e) => e['parentToolId'] === sub.parentToolId)
        expect(ev).toBeDefined()
        expect(ev!['agentId']).toBe(sub.agentId)
      }
    })

    it('never cross-assigns agentIds between parallel subagents', async () => {
      const { meta, sseEvents } = await replayFixture('parallel-subagents')

      // For each subagent, all subagent_updated events should reference only its own agentId
      for (const sub of meta.subagents) {
        const updatesForSub = sseEvents.filter(
          (e) => e['type'] === 'subagent_updated' && e['parentToolId'] === sub.parentToolId && e['agentId']
        )
        const otherAgentIds = meta.subagents
          .filter((s) => s.parentToolId !== sub.parentToolId)
          .map((s) => s.agentId)

        for (const ev of updatesForSub) {
          for (const otherId of otherAgentIds) {
            expect(ev['agentId']).not.toBe(otherId)
          }
        }
      }
    })
  })

  describe('sequential different agent types', () => {
    it('broadcasts subagent_started with correct subagentType for each agent type', async () => {
      const { meta, sseEvents } = await replayFixture('sequential-different-types')

      const startedEvents = sseEvents.filter((e) => e['type'] === 'subagent_started')
      expect(startedEvents).toHaveLength(2)

      // First should be web-browser, second should be dashboard-builder
      const browserStart = startedEvents.find((e) => e['subagentType'] === 'web-browser')
      const dashboardStart = startedEvents.find((e) => e['subagentType'] === 'dashboard-builder')

      expect(browserStart).toBeDefined()
      expect(dashboardStart).toBeDefined()
      expect(browserStart!['parentToolId']).toBe(meta.subagents[0].parentToolId)
      expect(dashboardStart!['parentToolId']).toBe(meta.subagents[1].parentToolId)
    })

    it('completes sequential subagents in order with correct agentIds', async () => {
      const { meta, sseEvents } = await replayFixture('sequential-different-types')

      const completedEvents = sseEvents.filter((e) => e['type'] === 'subagent_completed')
      expect(completedEvents).toHaveLength(2)

      // First completed should be the web-browser agent
      expect(completedEvents[0]['parentToolId']).toBe(meta.subagents[0].parentToolId)
      expect(completedEvents[0]['agentId']).toBe(meta.subagents[0].agentId)

      // Second should be dashboard-builder
      expect(completedEvents[1]['parentToolId']).toBe(meta.subagents[1].parentToolId)
      expect(completedEvents[1]['agentId']).toBe(meta.subagents[1].agentId)
    })
  })

  describe('single subagent with progress', () => {
    it('broadcasts subagent_started immediately on task_started', async () => {
      const { meta, sseEvents } = await replayFixture('single-subagent-progress')

      const startedEvents = sseEvents.filter((e) => e['type'] === 'subagent_started')
      expect(startedEvents).toHaveLength(1)

      const ev = startedEvents[0]
      expect(ev['parentToolId']).toBe(meta.subagents[0].parentToolId)
      expect(ev['subagentType']).toBe(meta.subagents[0].subagentType)
      expect(ev['description']).toBe(meta.subagents[0].description)
    })

    it('broadcasts all task_progress events with usage data', async () => {
      const { meta, sseEvents } = await replayFixture('single-subagent-progress')

      const progressEvents = sseEvents.filter((e) => e['type'] === 'subagent_progress')

      // Should match the expected count from metadata
      if (meta.taskProgressCount) {
        expect(progressEvents).toHaveLength(meta.taskProgressCount)
      }

      // Each progress event should have usage with increasing token counts
      let prevTokens = 0
      for (const ev of progressEvents) {
        expect(ev['parentToolId']).toBe(meta.subagents[0].parentToolId)
        const usage = ev['usage'] as Record<string, number>
        expect(usage['total_tokens']).toBeGreaterThanOrEqual(prevTokens)
        prevTokens = usage['total_tokens']
      }
    })

    it('progress events carry lastToolName', async () => {
      const { sseEvents } = await replayFixture('single-subagent-progress')

      const progressEvents = sseEvents.filter((e) => e['type'] === 'subagent_progress')
      for (const ev of progressEvents) {
        expect(ev['lastToolName']).toBeDefined()
        expect(typeof ev['lastToolName']).toBe('string')
      }
    })

    it('completes with correct agentId', async () => {
      const { meta, sseEvents } = await replayFixture('single-subagent-progress')

      const completedEvents = sseEvents.filter((e) => e['type'] === 'subagent_completed')
      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0]['agentId']).toBe(meta.subagents[0].agentId)
    })
  })
})
