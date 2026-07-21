/**
 * Repro: a script_run request approved by the user leaves the session pinned to
 * `awaiting_input` for the whole time the host runs the script (up to the 30s exec
 * timeout). script_run sets awaiting when it needs approval, but nothing clears it
 * at approval time — the flag only drops when the script's tool_result lands after
 * execution. So every status consumer (tray, app menu, sidebar pill, home,
 * /api/agents) reports "needs input" while the host is actually running the script,
 * i.e. the wait has already flipped from the human to the machine.
 *
 * Sibling of the capability-review bug: both are out-of-band resolutions whose
 * tool_result backstop is delayed. The run-script route now calls
 * `clearPendingScriptRun` on approval (before exec); this drives the same clear.
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

describe('awaiting-input status while an approved host script runs', () => {
  afterEach(() => vi.clearAllMocks())

  it('clears awaiting once the script_run launch is approved (before its result arrives)', async () => {
    vi.resetModules()
    const { messagePersister } = await import('./message-persister')
    const { client, send } = createReplayClient()
    const sessionId = 'sess-script-repro'
    const agentSlug = 'agent-script-repro'
    const toolUseId = 'toolu_script_1'

    messagePersister.markSessionActive(sessionId, agentSlug)
    await messagePersister.subscribeToSession(sessionId, client, sessionId, agentSlug)

    // Drive the real stream path: a request_script_run tool_use that needs approval.
    send({ content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: toolUseId, name: 'mcp__user-input__request_script_run' } } } } as unknown as StreamMessage)
    send({ content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: JSON.stringify({ script: 'echo hi', scriptType: 'shell', explanation: 'test' }) } } } } as unknown as StreamMessage)
    send({ content: { type: 'stream_event', event: { type: 'content_block_stop' } } } as unknown as StreamMessage)
    await tick()

    expect(messagePersister.isSessionAwaitingInput(sessionId)).toBe(true) // correct: awaiting approval

    messagePersister.clearPendingScriptRun(sessionId, toolUseId) // user approves; host now runs the script
    await tick()

    expect(messagePersister.isSessionAwaitingInput(sessionId)).toBe(false) // was stuck true through execution

    messagePersister.unsubscribeFromSession(sessionId)
  })
})
