/**
 * Repro: a subagent/workflow launch approved under a 'review' policy leaves the
 * parent session pinned to `awaiting_input` for the whole time the subagent runs.
 * `completeCapabilityReview` closes the card but never clears `isAwaitingInput`;
 * the flag only drops when the Task's tool_result arrives (minutes later). Every
 * status consumer (tray, app menu, sidebar pill, home, /api/agents) then reports
 * "needs input" while the agent is actually working, waiting on the subagent.
 * Only manifests under 'review' policy (default 'allow' never pauses the launch).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { ContainerClient, StreamMessage } from './types'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ subagents: 'review', workflows: 'review' }),
  VALID_SCRIPT_TYPES: { darwin: ['applescript', 'shell'], linux: ['shell'], win32: ['powershell'] },
}))
vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('not-automation')),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerSessionComplete: vi.fn(() => Promise.resolve()),
    triggerSessionWaitingInput: vi.fn(() => Promise.resolve()),
  },
}))
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({ connectedAccounts: {} }))
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }))

function createReplayClient(): { client: ContainerClient; send: (m: StreamMessage) => void } {
  let callback: ((message: StreamMessage) => void) | null = null
  const client = {
    subscribeToStream: vi.fn((_sid: string, cb: (message: StreamMessage) => void) => {
      callback = cb
      return { unsubscribe: vi.fn(), ready: Promise.resolve() }
    }),
    start: vi.fn(), stop: vi.fn(), stopSync: vi.fn(), getInfoFromRuntime: vi.fn(), getInfo: vi.fn(),
    fetch: vi.fn(() => Promise.reject(new Error('no container in test'))),
    waitForHealthy: vi.fn(), isHealthy: vi.fn(), getStats: vi.fn(), createSession: vi.fn(),
    getSession: vi.fn(() => Promise.resolve(null)), deleteSession: vi.fn(), sendMessage: vi.fn(),
    interruptSession: vi.fn(), on: vi.fn(), off: vi.fn(),
  } as unknown as ContainerClient
  return { client, send: (m) => callback?.(m) }
}

const tick = () => new Promise((r) => setTimeout(r, 20))

describe('awaiting-input status while an approved subagent runs (review policy)', () => {
  afterEach(() => vi.clearAllMocks())

  it('clears awaiting once the subagent launch is approved (before its result arrives)', async () => {
    vi.resetModules()
    const { messagePersister } = await import('./message-persister')
    const { client, send } = createReplayClient()
    const sessionId = 'sess-review-repro'
    const agentSlug = 'agent-review-repro'
    const toolUseId = 'toolu_task_1'

    messagePersister.markSessionActive(sessionId, agentSlug)
    await messagePersister.subscribeToSession(sessionId, client, sessionId, agentSlug)

    send({ content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: toolUseId, name: 'Task' } } } } as unknown as StreamMessage)
    send({ content: { type: 'stream_event', event: { type: 'content_block_stop' } } } as unknown as StreamMessage)
    await tick()

    expect(messagePersister.isSessionAwaitingInput(sessionId)).toBe(true) // correct: awaiting approval

    messagePersister.completeCapabilityReview(sessionId, toolUseId) // user approves
    await tick()

    expect(messagePersister.isSessionAwaitingInput(sessionId)).toBe(false) // was stuck true

    messagePersister.unsubscribeFromSession(sessionId)
  })
})
