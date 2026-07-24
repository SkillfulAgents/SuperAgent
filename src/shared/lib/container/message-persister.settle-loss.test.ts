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
const streamEvent = {
  type: 'stream_event',
  event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
}

afterEach(() => {
  vi.useRealTimers()
})

describe('message-persister settle-signal loss', () => {
  it('settles when idle arrives after an external re-subscribe that followed a result', async () => {
    const { persister } = await freshPersister()
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
    persister.unsubscribeFromSession(SESSION_ID)
  })

  it('settles within grace when a result was seen and idle never arrives', async () => {
    vi.useFakeTimers()
    const { persister, RESULT_IDLE_GRACE_MS } = await freshPersister()
    const { client, send } = makeClient()
    await persister.subscribeToSession(SESSION_ID, client, SESSION_ID, AGENT_SLUG)
    persister.markSessionActive(SESSION_ID, AGENT_SLUG)
    send(capabilities)
    send(successResult)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)

    await vi.advanceTimersByTimeAsync(RESULT_IDLE_GRACE_MS)
    expect(persister.isSessionActive(SESSION_ID)).toBe(false)
    persister.unsubscribeFromSession(SESSION_ID)
  })

  // Anchor regression: turn-1 result arms grace; queued turn-2 emits running
  // while host isActive is still true (self-heal no-ops); stale timer must not
  // settle on turn 1's result. Turn-2 result + idle settles normally.
  it('does not false-settle mid-turn when running arrives while still active after a result', async () => {
    vi.useFakeTimers()
    const { persister, RESULT_IDLE_GRACE_MS } = await freshPersister()
    const { notificationManager } = await import('@shared/lib/notifications/notification-manager')
    vi.mocked(notificationManager.triggerSessionComplete).mockClear()
    const { client, send } = makeClient()
    await persister.subscribeToSession(SESSION_ID, client, SESSION_ID, AGENT_SLUG)
    persister.markSessionActive(SESSION_ID, AGENT_SLUG)
    send(capabilities)
    send(successResult)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)

    send(running)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)

    await vi.advanceTimersByTimeAsync(RESULT_IDLE_GRACE_MS)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)
    expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()

    send(successResult)
    send(idle)
    expect(persister.isSessionActive(SESSION_ID)).toBe(false)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
    persister.unsubscribeFromSession(SESSION_ID)
  })

  it('cancels grace on stream_event activity without settling', async () => {
    vi.useFakeTimers()
    const { persister, RESULT_IDLE_GRACE_MS } = await freshPersister()
    const { client, send } = makeClient()
    await persister.subscribeToSession(SESSION_ID, client, SESSION_ID, AGENT_SLUG)
    persister.markSessionActive(SESSION_ID, AGENT_SLUG)
    send(capabilities)
    send(successResult)
    send(streamEvent)

    await vi.advanceTimersByTimeAsync(RESULT_IDLE_GRACE_MS)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)
    persister.unsubscribeFromSession(SESSION_ID)
  })

  it('does not false-settle a quiet tool after cancel (timer stays disarmed)', async () => {
    vi.useFakeTimers()
    const { persister } = await freshPersister()
    const { client, send } = makeClient()
    await persister.subscribeToSession(SESSION_ID, client, SESSION_ID, AGENT_SLUG)
    persister.markSessionActive(SESSION_ID, AGENT_SLUG)
    send(capabilities)
    send(successResult)
    send(running)
    send(streamEvent)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)
    persister.unsubscribeFromSession(SESSION_ID)
  })

  it('fires completion notification exactly once when idle finalizes before grace', async () => {
    vi.useFakeTimers()
    const { persister, RESULT_IDLE_GRACE_MS } = await freshPersister()
    const { notificationManager } = await import('@shared/lib/notifications/notification-manager')
    vi.mocked(notificationManager.triggerSessionComplete).mockClear()
    const { client, send } = makeClient()
    await persister.subscribeToSession(SESSION_ID, client, SESSION_ID, AGENT_SLUG)
    persister.markSessionActive(SESSION_ID, AGENT_SLUG)
    send(capabilities)
    send(successResult)
    send(idle)
    expect(persister.isSessionActive(SESSION_ID)).toBe(false)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RESULT_IDLE_GRACE_MS)
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
    persister.unsubscribeFromSession(SESSION_ID)
  })

  it('does not settle on the grace timer while background work is open', async () => {
    vi.useFakeTimers()
    const { persister, RESULT_IDLE_GRACE_MS } = await freshPersister()
    const { client, send } = makeClient()
    await persister.subscribeToSession(SESSION_ID, client, SESSION_ID, AGENT_SLUG)
    persister.markSessionActive(SESSION_ID, AGENT_SLUG)
    send(capabilities)
    // Same registration path the suite uses for background Bash holds.
    send({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'bg-1' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running in background' }] },
    })
    send(successResult)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)

    await vi.advanceTimersByTimeAsync(RESULT_IDLE_GRACE_MS)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)
    persister.unsubscribeFromSession(SESSION_ID)
  })

  it('does not settle on the grace timer while an awaiting shelf is open', async () => {
    vi.useFakeTimers()
    const { persister, RESULT_IDLE_GRACE_MS } = await freshPersister()
    const { client, send } = makeClient()
    await persister.subscribeToSession(SESSION_ID, client, SESSION_ID, AGENT_SLUG)
    persister.markSessionActive(SESSION_ID, AGENT_SLUG)
    send(capabilities)
    send(successResult)
    persister.markAwaitingInput(SESSION_ID)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)

    await vi.advanceTimersByTimeAsync(RESULT_IDLE_GRACE_MS)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)
    persister.unsubscribeFromSession(SESSION_ID)
  })

  it('does not settle on the grace timer while an external review blocker is open', async () => {
    vi.useFakeTimers()
    const { persister, RESULT_IDLE_GRACE_MS } = await freshPersister()
    const { client, send } = makeClient()
    await persister.subscribeToSession(SESSION_ID, client, SESSION_ID, AGENT_SLUG)
    persister.markSessionActive(SESSION_ID, AGENT_SLUG)
    send(capabilities)
    send(successResult)
    const unregister = persister.registerAwaitingBlockerSource((slug) => slug === AGENT_SLUG)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)

    await vi.advanceTimersByTimeAsync(RESULT_IDLE_GRACE_MS)
    expect(persister.isSessionActive(SESSION_ID)).toBe(true)
    unregister()
    persister.unsubscribeFromSession(SESSION_ID)
  })
})
