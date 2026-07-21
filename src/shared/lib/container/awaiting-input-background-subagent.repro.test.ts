/**
 * Repro: the main-path 'user' tool_result clear over-clears the awaiting light
 * while a background subagent still needs the human.
 *
 * A background subagent (run_in_background) runs concurrently with the main turn.
 * When it hits a blocking input tool its request is registered on the PARENT
 * session's shelves (pendingInputRequests + isAwaitingInput) via the sidechain
 * path. Meanwhile the main agent keeps working; when it finishes an ordinary tool
 * its tool_result arrives as a main-path 'user' message. That handler cleared
 * isAwaitingInput UNCONDITIONALLY (the one clear site missing the both-shelves
 * `hasBlockingPendingRequests` guard), so the "needs input" pill vanished while
 * the subagent was still parked on the user.
 *
 * Fix: delete the resolved id first (handleToolResults), then clear only when no
 * blocking request remains across both shelves.
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

describe('awaiting-input status while a background subagent is parked on the user', () => {
  afterEach(() => vi.clearAllMocks())

  it('keeps awaiting when the main agent completes a tool but the subagent still needs input', async () => {
    vi.resetModules()
    const { messagePersister } = await import('./message-persister')
    const { client, send } = createReplayClient()
    const sessionId = 'sess-bg-subagent-repro'
    const agentSlug = 'agent-bg-subagent-repro'
    const subInputId = 'toolu_subagent_browser_input'
    const mainToolResultId = 'toolu_main_bash'

    messagePersister.markSessionActive(sessionId, agentSlug)
    await messagePersister.subscribeToSession(sessionId, client, sessionId, agentSlug)

    // A background subagent (sidechain: parent_tool_use_id set) hits request_browser_input.
    // Its ask is registered on the PARENT session and marks it awaiting.
    send({ content: { type: 'assistant', parent_tool_use_id: 'parent-task-1', message: { content: [
      { type: 'tool_use', id: subInputId, name: 'mcp__user-input__request_browser_input', input: { message: 'Pick an option' } },
    ] } } } as unknown as StreamMessage)
    await tick()

    expect(messagePersister.isSessionAwaitingInput(sessionId)).toBe(true) // correct: the subagent needs the human

    // The still-working main agent finishes an ordinary tool; its tool_result arrives on
    // the MAIN path (no parent_tool_use_id) for a DIFFERENT id than the subagent's ask.
    send({ content: { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: mainToolResultId, content: 'done', is_error: false },
    ] } } } as unknown as StreamMessage)
    await tick()

    // The subagent's browser_input is still pending — the pill must stay up.
    expect(messagePersister.isSessionAwaitingInput(sessionId)).toBe(true) // was over-cleared to false

    // Sanity: once the subagent's own request resolves, awaiting clears normally.
    send({ content: { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: subInputId, content: 'option A', is_error: false },
    ] } } } as unknown as StreamMessage)
    await tick()

    expect(messagePersister.isSessionAwaitingInput(sessionId)).toBe(false)

    messagePersister.unsubscribeFromSession(sessionId)
  })
})
