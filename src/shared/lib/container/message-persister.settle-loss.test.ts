/**
 * Settle-signal loss: re-subscribe must keep reply memory, and a grace-after-
 * result backstop must settle only when nothing is genuinely pending.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { ContainerClient, StreamMessage } from './types'

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  createScheduledTask: vi.fn(),
}))
vi.mock('@shared/lib/services/session-service', () => ({
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
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
  computerUseMethodFromToolName: vi.fn((toolName: string) =>
    toolName.replace('mcp__computer-use__computer_', '')
  ),
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
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentSessionsDir: (_agentSlug: string) => '/nonexistent',
}))

const SESSION_ID = 'settle-loss-session'
const AGENT_SLUG = 'settle-loss-agent'

function makeClient(): { client: ContainerClient; send: (content: Record<string, unknown>) => void } {
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
    interruptSession: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as ContainerClient
  return {
    client,
    send: (content) =>
      callback?.({ type: 'message', content, timestamp: new Date(), sessionId: SESSION_ID } as StreamMessage),
  }
}

async function freshPersister() {
  vi.resetModules()
  const { messagePersister, RESULT_IDLE_GRACE_MS } = await import('./message-persister')
  return { persister: messagePersister, RESULT_IDLE_GRACE_MS }
}

const capabilities = { type: 'system', subtype: 'capabilities', session_state_events: true }
const successResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 100,
  num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0 },
}
const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' }
const running = { type: 'system', subtype: 'session_state_changed', state: 'running' }
const requesting = { type: 'system', subtype: 'status', status: 'requesting' }
const streamEvent = {
  type: 'stream_event',
  event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
}

function sendToolUse(
  send: (content: Record<string, unknown>) => void,
  toolName: string,
  toolId: string,
  input: Record<string, unknown>
): void {
  send({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: toolId, name: toolName },
    },
  })
  send({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
  })
  send({
    type: 'stream_event',
    event: { type: 'content_block_stop' },
  })
}

async function startActiveSession() {
  vi.useFakeTimers()
  const { persister, RESULT_IDLE_GRACE_MS } = await freshPersister()
  const connection = makeClient()
  await persister.subscribeToSession(SESSION_ID, connection.client, SESSION_ID, AGENT_SLUG)
  persister.markSessionActive(SESSION_ID, AGENT_SLUG)
  connection.send(capabilities)
  return { persister, RESULT_IDLE_GRACE_MS, ...connection }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('message-persister settle-signal loss', () => {
  it('settles when idle arrives after an external re-subscribe that followed a result', async () => {
    vi.useFakeTimers()
    const { persister, RESULT_IDLE_GRACE_MS } = await freshPersister()
    const { notificationManager } = await import('@shared/lib/notifications/notification-manager')
    vi.mocked(notificationManager.triggerSessionComplete).mockClear()
    const first = makeClient()
    await persister.subscribeToSession(SESSION_ID, first.client, SESSION_ID, AGENT_SLUG)
    persister.markSessionActive(SESSION_ID, AGENT_SLUG)
    first.send(capabilities)
    first.send(successResult)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)

    // Socket died between result and idle; consumer re-subscribes before the
    // container records idle, so attach gets no replay and idle arrives live.
    const second = makeClient()
    await persister.subscribeToSession(SESSION_ID, second.client, SESSION_ID, AGENT_SLUG)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)

    second.send(idle)
    expect(persister.isSessionActive(SESSION_ID)).toBe(false)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RESULT_IDLE_GRACE_MS)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
    persister.unsubscribeFromSession(SESSION_ID)
  })

  it('settles within grace when a result was seen and idle never arrives', async () => {
    const { persister, RESULT_IDLE_GRACE_MS, send } = await startActiveSession()
    const { notificationManager } = await import('@shared/lib/notifications/notification-manager')
    vi.mocked(notificationManager.triggerSessionComplete).mockClear()
    send(successResult)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)

    await vi.advanceTimersByTimeAsync(RESULT_IDLE_GRACE_MS)
    expect(persister.isSessionActive(SESSION_ID)).toBe(false)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RESULT_IDLE_GRACE_MS)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
    persister.unsubscribeFromSession(SESSION_ID)
  })

  it.each([
    ['running', running],
    ['requesting', requesting],
    ['replayed running after reconnect', { ...running, replayed: true }],
  ])('does not false-settle after %s proves a successor turn started', async (_label, newTurnFrame) => {
    const { persister, send } = await startActiveSession()
    const { notificationManager } = await import('@shared/lib/notifications/notification-manager')
    vi.mocked(notificationManager.triggerSessionComplete).mockClear()
    send(successResult)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)

    send(newTurnFrame)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)
    expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()

    send(successResult)
    send(idle)
    expect(persister.isSessionActive(SESSION_ID)).toBe(false)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
    persister.unsubscribeFromSession(SESSION_ID)
  })

  it('cancels grace on output activity without clearing the observed result', async () => {
    const { persister, RESULT_IDLE_GRACE_MS, send } = await startActiveSession()
    send(successResult)
    send(streamEvent)

    await vi.advanceTimersByTimeAsync(RESULT_IDLE_GRACE_MS)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)
    send(idle)
    expect(persister.isSessionActive(SESSION_ID)).toBe(false)
    persister.unsubscribeFromSession(SESSION_ID)
  })

  it.each([
    'incremental background work',
    'snapshot-only background work',
    'awaiting input',
    'pending request after result clears awaiting',
    'external review blocker',
  ])('does not settle on grace while blocked by %s', async (blocker) => {
    const { persister, RESULT_IDLE_GRACE_MS, send } = await startActiveSession()
    let cleanup = () => {}
    if (blocker === 'incremental background work') {
      send({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-1' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
    } else if (blocker === 'pending request after result clears awaiting') {
      sendToolUse(send, 'mcp__user-input__request_secret', 'secret-1', { secretName: 'API_KEY' })
    }
    send(successResult)
    if (blocker === 'snapshot-only background work') {
      send({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'snapshot-only' }],
      })
    } else if (blocker === 'awaiting input') {
      persister.markAwaitingInput(SESSION_ID)
    } else if (blocker === 'external review blocker') {
      cleanup = persister.registerAwaitingBlockerSource((slug) => slug === AGENT_SLUG)
    }
    await vi.advanceTimersByTimeAsync(RESULT_IDLE_GRACE_MS)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)
    cleanup()
    persister.unsubscribeFromSession(SESSION_ID)
  })
})
