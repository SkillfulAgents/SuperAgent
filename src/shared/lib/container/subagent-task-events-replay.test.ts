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
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('not-automation')),
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
  // Background-Bash fixtures: the explicitly-backgrounded task and the foreground
  // task whose `task_notification` must NOT be mistaken for it.
  backgroundTaskId?: string
  foregroundTaskId?: string
  // Premature-idle fixtures: replay must mark the session active first (the user's
  // message that started the turn predates the capture) for the idle handler's
  // `isActive && lastResultSubtype` gate to fire.
  startActive?: boolean
  // One entry per backgrounded local_bash task in the capture, with the anchor
  // timestamps from the stream (documentation; the test recomputes dynamically).
  backgroundTasks?: Array<{ taskId: string; label?: string; prematureIdleT?: number; realCompletionT?: number }>
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

// Per-entry snapshot taken right after each stream message is processed. Lets a
// test assert the session/background-task state *at the moment* a specific
// message was handled — e.g. that a still-running Bash task was NOT cleared when
// a premature `session_state_changed:'idle'` arrived mid-flight.
interface ReplaySnapshot {
  index: number
  t: number
  type?: string
  subtype?: string
  state?: string
  taskId?: string
  status?: string
  // Terminal status for task_updated lives in `patch.status`, not top-level.
  patchStatus?: string
  taskType?: string
  isActive: boolean
  // Background task ids cleared so far (cumulative, in emission order).
  bgCompletedIds: string[]
  // Cumulative count of session_idle events emitted so far.
  sessionIdleCount: number
}

// Like replayFixture, but (a) marks the session active before subscribing — the
// turn-starting user message predates the capture, and the idle handler's
// phantom-clear is gated on `isActive` — and (b) records a per-entry timeline so
// a test can inspect state at the exact message that should (not) have cleared a
// task. Background-task tracking lives entirely in the persister's in-memory
// state, so no fs-snapshot is needed.
async function replayFixtureTracked(fixtureName: string): Promise<{
  meta: FixtureMeta
  sseEvents: Array<Record<string, unknown>>
  timeline: ReplaySnapshot[]
}> {
  const { meta, streamEntries } = await loadFixture(fixtureName)

  vi.resetModules()
  const { messagePersister } = await import('./message-persister')
  const { client, send } = createReplayClient()

  const sseEvents: Array<Record<string, unknown>> = []
  const cleanup = messagePersister.addSSEClient(meta.sessionId, (data) => {
    sseEvents.push(data as Record<string, unknown>)
  })

  // The real turn was kicked off by a user message before the capture window, so
  // mark active first; subscribeToSession preserves the prior isActive.
  if (meta.startActive) {
    messagePersister.markSessionActive(meta.sessionId, meta.agentSlug)
  }
  await messagePersister.subscribeToSession(meta.sessionId, client, meta.sessionId, meta.agentSlug)

  const timeline: ReplaySnapshot[] = []
  for (let i = 0; i < streamEntries.length; i++) {
    const entry = streamEntries[i]
    send(entry.message)
    await new Promise((r) => setImmediate(r))

    const c = (entry.message?.content ?? {}) as Record<string, unknown>
    timeline.push({
      index: i,
      t: entry.t,
      type: c['type'] as string | undefined,
      subtype: c['subtype'] as string | undefined,
      state: c['state'] as string | undefined,
      taskId: c['task_id'] as string | undefined,
      status: c['status'] as string | undefined,
      patchStatus: (c['patch'] as { status?: string } | undefined)?.status,
      taskType: c['task_type'] as string | undefined,
      isActive: messagePersister.isSessionActive(meta.sessionId),
      bgCompletedIds: sseEvents
        .filter((e) => e['type'] === 'background_task_completed')
        .map((e) => e['taskId'] as string),
      sessionIdleCount: sseEvents.filter((e) => e['type'] === 'session_idle').length,
    })
  }

  await new Promise((r) => setTimeout(r, 50))
  cleanup()
  messagePersister.unsubscribeFromSession(meta.sessionId)

  return { meta, sseEvents, timeline }
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

  // Real capture of the background-Bash "busy completion" bug. The background task
  // settles while the agent is blocked on a foreground tool, so its completion arrives
  // as a `task_updated` patch (not a matching `task_notification`). Regression guard:
  // the persister must clear it and let the session go idle instead of getting stuck.
  describe('background Bash busy-completion (real capture)', () => {
    it('clears the background task via task_updated and reaches idle (not stuck waiting)', async () => {
      const { meta, sseEvents } = await replayFixture('background-bash-busy-completion')
      const bgId = meta.backgroundTaskId!

      // The background task was registered on start.
      const started = sseEvents.filter((e) => e['type'] === 'background_task_started')
      expect(started.map((e) => e['taskId'])).toContain(bgId)

      // It must be cleared — this is the bug: before the fix, the busy-path
      // `task_updated{status:completed}` for bgId was ignored and nothing cleared it.
      const completed = sseEvents.filter((e) => e['type'] === 'background_task_completed')
      expect(completed.map((e) => e['taskId'])).toContain(bgId)

      // The session must end idle, NOT pinned waiting on a phantom background task.
      expect(sseEvents.some((e) => e['type'] === 'session_idle')).toBe(true)
      expect(sseEvents.some((e) => e['type'] === 'session_waiting_background')).toBe(false)
    })

    it('does not mistake the foreground task_notification for the background task', async () => {
      const { meta, sseEvents } = await replayFixture('background-bash-busy-completion')
      const fgId = meta.foregroundTaskId!

      // The only `task_notification` in this capture is for the foreground command
      // (a different id), which was never a tracked background task — so it must not
      // produce a background_task_completed for the foreground id.
      const completed = sseEvents.filter((e) => e['type'] === 'background_task_completed')
      expect(completed.map((e) => e['taskId'])).not.toContain(fgId)
    })
  })

  // Real capture of the premature-idle regression (ac23bdd8). A Bash
  // run_in_background (task_type=local_bash) keeps running past turn-end, but the
  // SDK emits session_state_changed:'idle' at turn-end ANYWAY — it re-emits
  // 'running' + task_notification{completed} when the bash actually finishes. The
  // idle handler must not treat the still-running task as a phantom: clearing it +
  // finalizeIdle there drops the background indicator and un-gates auto-sleep,
  // killing the job mid-flight. This capture has two such tasks back-to-back: a
  // ~0.2s one (by2nbnmbo) and a 30s sleep (bp2edegys, ~28s premature-idle→done gap).
  describe('background Bash premature-idle (real capture)', () => {
    // Locate, for one background task, the three load-bearing stream entries:
    //   started   — task_started{local_bash}
    //   completed — its FIRST real terminal signal. A backgrounded Bash command
    //               settles via task_updated{patch.status:completed} (the
    //               busy-completion path) and/or a redundant follow-up
    //               task_notification{status:completed}; whichever lands first is
    //               the legitimate end.
    //   premature — the FIRST session_state_changed:'idle' between started and
    //               completed (turn-end fired while the bash was still running)
    const isTerminal = (s: ReplaySnapshot, taskId: string) =>
      s.taskId === taskId &&
      ((s.subtype === 'task_notification' && s.status === 'completed') ||
        (s.subtype === 'task_updated' &&
          (s.patchStatus === 'completed' || s.patchStatus === 'failed' || s.patchStatus === 'killed')))
    function anchors(timeline: ReplaySnapshot[], taskId: string) {
      const startedIdx = timeline.findIndex((s) => s.subtype === 'task_started' && s.taskId === taskId)
      const completedIdx = timeline.findIndex((s) => isTerminal(s, taskId))
      const prematureIdx = timeline.findIndex(
        (s, i) =>
          i > startedIdx && i < completedIdx && s.subtype === 'session_state_changed' && s.state === 'idle'
      )
      return { startedIdx, prematureIdx, completedIdx }
    }

    it('keeps the session active and the task tracked for the full time the bash runs', async () => {
      const { meta, timeline } = await replayFixtureTracked('background-bash-premature-idle')
      expect(meta.backgroundTasks?.length ?? 0).toBeGreaterThan(0)

      for (const { taskId, label } of meta.backgroundTasks!) {
        const { startedIdx, prematureIdx, completedIdx } = anchors(timeline, taskId)
        expect(startedIdx, `${label}: task_started present`).toBeGreaterThanOrEqual(0)
        expect(completedIdx, `${label}: real completion present`).toBeGreaterThan(startedIdx)
        // The fixture must actually exercise the hazard: a turn-end idle mid-flight.
        expect(prematureIdx, `${label}: a premature idle exists mid-flight`).toBeGreaterThan(startedIdx)
        expect(prematureIdx).toBeLessThan(completedIdx)

        // Across the entire window the bash is running, the session must stay active
        // (auto-sleep blocked) and the task must stay tracked (indicator persists).
        for (let i = startedIdx + 1; i < completedIdx; i++) {
          expect(timeline[i].isActive, `${label}: session finalized mid-flight at entry ${i}`).toBe(true)
          expect(timeline[i].bgCompletedIds, `${label}: cleared mid-flight at entry ${i}`).not.toContain(taskId)
        }
      }
    })

    it('clears each background task exactly once, only at its real terminal signal', async () => {
      const { meta, timeline, sseEvents } = await replayFixtureTracked('background-bash-premature-idle')

      for (const { taskId, label } of meta.backgroundTasks!) {
        const { completedIdx } = anchors(timeline, taskId)
        // Cleared by the time the real terminal signal is processed...
        expect(timeline[completedIdx].bgCompletedIds, `${label}: cleared at terminal signal`).toContain(taskId)
        // ...and NOT one entry earlier (i.e. not at the premature idle / result).
        expect(
          timeline[completedIdx - 1].bgCompletedIds,
          `${label}: not cleared before terminal signal`
        ).not.toContain(taskId)
      }

      const completedIds = sseEvents
        .filter((e) => e['type'] === 'background_task_completed')
        .map((e) => e['taskId'])
      for (const { taskId, label } of meta.backgroundTasks!) {
        expect(completedIds.filter((x) => x === taskId), `${label}: completed exactly once`).toHaveLength(1)
      }
    })

    it('does not finalize the session (session_idle) while a bash is still running', async () => {
      const { meta, timeline } = await replayFixtureTracked('background-bash-premature-idle')

      for (const { taskId, label } of meta.backgroundTasks!) {
        const { startedIdx, completedIdx } = anchors(timeline, taskId)
        // No new session_idle may be emitted between a task's start and its real
        // completion — the premature turn-end idle must degrade to waiting-background.
        const idleAtStart = timeline[startedIdx].sessionIdleCount
        for (let i = startedIdx + 1; i < completedIdx; i++) {
          expect(
            timeline[i].sessionIdleCount,
            `${label}: session_idle finalized mid-flight at entry ${i}`
          ).toBe(idleAtStart)
        }
      }
    })
  })

  // Real capture of a run_in_background SUBAGENT (task_type 'local_agent'). Its
  // completion arrives as task_updated/task_notification (never a second
  // tool_result, never a sidechain 'result'), so without the dedicated handling
  // broadcastSubagentCompleted never fires and the UI shows it running until the
  // whole turn ends. Regression guard: it must complete mid-turn, before idle.
  describe('background subagent completion (real capture)', () => {
    it('broadcasts subagent_completed for the background subagent with its agentId', async () => {
      const { meta, sseEvents } = await replayFixture('background-subagent-completion')
      const sub = meta.subagents[0]

      // The background subagent must complete exactly once (driven by its
      // task_updated/task_notification — without the fix it never fires). The
      // capture also contains a later synchronous Bash step that legitimately
      // completes via its own tool_result, so filter to the background subagent.
      const bg = sseEvents.filter(
        (e) => e['type'] === 'subagent_completed' && e['parentToolId'] === sub.parentToolId
      )
      expect(bg).toHaveLength(1)
      expect(bg[0]['agentId']).toBe(sub.agentId)
    })

    it('completes the background subagent mid-turn, before the final result is processed', async () => {
      const { meta, sseEvents } = await replayFixture('background-subagent-completion')
      const sub = meta.subagents[0]

      const completedIdx = sseEvents.findIndex(
        (e) => e['type'] === 'subagent_completed' && e['parentToolId'] === sub.parentToolId
      )
      // The result-driven turn end is signalled to the renderer as turn_output_complete.
      const turnEndIdx = sseEvents.findIndex((e) => e['type'] === 'turn_output_complete')
      expect(completedIdx).toBeGreaterThanOrEqual(0)
      expect(turnEndIdx).toBeGreaterThanOrEqual(0)
      expect(completedIdx).toBeLessThan(turnEndIdx)
    })
  })

  // Real capture (2026-07-02, claude-agent-sdk 0.3.197) of the premature-idle
  // regression for background SUBAGENTS (task_type 'local_agent'). Older SDKs held
  // the turn's result/idle back until background agents finished, so the session
  // stayed working with no host-side tracking. 0.3.197's background-by-default
  // subagent rework settles the turn immediately: session_state_changed:'idle'
  // fires while the subagent still has ~28s to run, and the completion arrives
  // ~31s later as task_updated + 'running' + task_notification. The idle handler
  // must treat a running background subagent exactly like a backgrounded Bash:
  // surface session_waiting_background and do NOT finalize — finalizing drops the
  // indicator and un-gates container auto-sleep mid-job.
  describe('background subagent premature-idle (real capture)', () => {
    const isTerminal = (s: ReplaySnapshot, taskId: string) =>
      s.taskId === taskId &&
      ((s.subtype === 'task_notification' && s.status === 'completed') ||
        (s.subtype === 'task_updated' &&
          (s.patchStatus === 'completed' || s.patchStatus === 'failed' || s.patchStatus === 'killed')))

    it('keeps the session active and un-finalized for the full time the subagent runs', async () => {
      const { meta, timeline } = await replayFixtureTracked('background-subagent-premature-idle')
      const taskId = meta.subagents[0].taskId!

      const startedIdx = timeline.findIndex((s) => s.subtype === 'task_started' && s.taskId === taskId)
      const completedIdx = timeline.findIndex((s) => isTerminal(s, taskId))
      const prematureIdx = timeline.findIndex(
        (s, i) =>
          i > startedIdx && i < completedIdx && s.subtype === 'session_state_changed' && s.state === 'idle'
      )
      expect(startedIdx).toBeGreaterThanOrEqual(0)
      expect(completedIdx).toBeGreaterThan(startedIdx)
      // The capture's defining feature: a turn-end idle between launch and completion.
      expect(prematureIdx).toBeGreaterThan(startedIdx)

      for (let i = startedIdx; i < completedIdx; i++) {
        expect(timeline[i].isActive, `session finalized mid-flight at entry ${i} (${timeline[i].subtype})`).toBe(
          true
        )
        expect(timeline[i].sessionIdleCount, `session_idle emitted mid-flight at entry ${i}`).toBe(0)
      }
    })

    it('tracks the subagent as a background task and surfaces the waiting state at the premature idle', async () => {
      const { meta, sseEvents } = await replayFixtureTracked('background-subagent-premature-idle')
      const taskId = meta.subagents[0].taskId!

      const started = sseEvents.filter((e) => e['type'] === 'background_task_started')
      expect(started.map((e) => e['taskId'])).toContain(taskId)
      // Flagged so the renderer can skip it in the generic "N background
      // processes" row — the named subagent row already shows this work.
      expect(started.find((e) => e['taskId'] === taskId)?.['isSubagent']).toBe(true)

      // The premature turn-end idle must downgrade to waiting-on-background.
      expect(sseEvents.some((e) => e['type'] === 'session_waiting_background')).toBe(true)

      const completed = sseEvents.filter((e) => e['type'] === 'background_task_completed')
      expect(completed.map((e) => e['taskId'])).toContain(taskId)
    })

    it('finalizes exactly once, at the truly-settled idle after the wake turn', async () => {
      const { meta, timeline } = await replayFixtureTracked('background-subagent-premature-idle')
      const taskId = meta.subagents[0].taskId!

      const completedIdx = timeline.findIndex((s) => isTerminal(s, taskId))
      const last = timeline[timeline.length - 1]
      expect(last.sessionIdleCount).toBe(1)
      expect(last.isActive).toBe(false)
      // ...and that single finalize happened after the real completion.
      const firstIdleIdx = timeline.findIndex((s) => s.sessionIdleCount > 0)
      expect(firstIdleIdx).toBeGreaterThan(completedIdx)
    })

    it('completes the subagent card once and ignores the leaked inner-bash task_started', async () => {
      const { meta, sseEvents } = await replayFixtureTracked('background-subagent-premature-idle')
      const sub = meta.subagents[0]

      const bg = sseEvents.filter(
        (e) => e['type'] === 'subagent_completed' && e['parentToolId'] === sub.parentToolId
      )
      expect(bg).toHaveLength(1)
      expect(bg[0]['agentId']).toBe(sub.agentId)

      // The subagent's INNER Bash leaks into the main stream as an unparented
      // task_started{task_type:'local_bash'} — it must not spawn a phantom
      // subagent card (it would linger for the whole background wait).
      const knownParents = meta.subagents.map((s) => s.parentToolId)
      const startedParents = sseEvents
        .filter((e) => e['type'] === 'subagent_started')
        .map((e) => e['parentToolId'])
      for (const p of startedParents) {
        expect(knownParents, `phantom subagent_started for ${String(p)}`).toContain(p)
      }
    })
  })
})
