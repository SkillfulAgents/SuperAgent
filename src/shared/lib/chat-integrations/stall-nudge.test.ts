import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  armStallNudge,
  resetStallNudgeIfArmed,
  cancelStallNudge,
  STALL_NUDGE_MS,
  STALL_NUDGE_TEXT,
  type ManagedConnector,
} from './chat-integration-manager'
import { MockChatClientConnector } from './mock-connector'
import { messagePersister } from '@shared/lib/container/message-persister'
import type { ChatIntegration } from '@shared/lib/db/schema'

function createManagedConnector(overrides?: Partial<ManagedConnector>): ManagedConnector {
  const connector = new MockChatClientConnector()
  return {
    connector,
    integration: {
      id: 'test-integration',
      agentSlug: 'test-agent',
      provider: 'telegram',
      name: 'Test Bot',
      config: '{}',
      showToolCalls: false,
      status: 'active',
      errorMessage: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as ChatIntegration,
    chatId: 'chat-123',
    sseUnsubscribe: null,
    messageUnsubscribe: null,
    interactiveUnsubscribe: null,
    errorUnsubscribe: null,
    streamingState: {
      currentMessageId: null,
      accumulatedText: '',
      lastUpdateTime: 0,
    },
    currentToolInput: '',
    pendingToolMessages: [],
    sessionId: 'session-1',
    ...overrides,
  }
}

function getMock(managed: ManagedConnector): MockChatClientConnector {
  return managed.connector as MockChatClientConnector
}

describe('stall nudge timer', () => {
  let activitySpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    activitySpy = vi.spyOn(messagePersister, 'getSessionActivity').mockReturnValue('working')
  })

  afterEach(() => {
    vi.useRealTimers()
    activitySpy.mockRestore()
  })

  it('fires exactly one nudge after the silence threshold', async () => {
    const managed = createManagedConnector()
    armStallNudge(managed, 'session-1')

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(getMock(managed).sentMessages).toHaveLength(1)
    expect(getMock(managed).sentMessages[0].message.text).toBe(STALL_NUDGE_TEXT)
    expect(managed.stallNotified).toBe(true)
  })

  it('reset defers firing - silence is measured from the last event', async () => {
    const managed = createManagedConnector()
    armStallNudge(managed, 'session-1')

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS - 60_000)
    resetStallNudgeIfArmed(managed, 'session-1')
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS - 60_000)

    expect(getMock(managed).sentMessages).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(getMock(managed).sentMessages).toHaveLength(1)
  })

  it('reset is a no-op when no timer is armed', () => {
    const managed = createManagedConnector()
    resetStallNudgeIfArmed(managed, 'session-1')
    expect(managed.stallNudgeTimer).toBeUndefined()
  })

  it('cancel prevents firing', async () => {
    const managed = createManagedConnector()
    armStallNudge(managed, 'session-1')
    cancelStallNudge(managed)

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS * 2)

    expect(getMock(managed).sentMessages).toHaveLength(0)
    expect(managed.stallNudgeTimer).toBeNull()
  })

  it('does not fire when the turn already settled at fire time', async () => {
    const managed = createManagedConnector()
    armStallNudge(managed, 'session-1')
    activitySpy.mockReturnValue('idle')

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(getMock(managed).sentMessages).toHaveLength(0)
  })

  it('does not fire while the agent awaits user input (the user owes progress)', async () => {
    const managed = createManagedConnector()
    armStallNudge(managed, 'session-1')
    activitySpy.mockReturnValue('awaiting')

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(getMock(managed).sentMessages).toHaveLength(0)
  })

  it('fires on a turn hung mid-stream (streaming is agent-owed progress)', async () => {
    const managed = createManagedConnector()
    armStallNudge(managed, 'session-1')
    activitySpy.mockReturnValue('streaming')

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(getMock(managed).sentMessages).toHaveLength(1)
  })

  it('fires at most once per turn (latch survives a re-arm)', async () => {
    const managed = createManagedConnector()
    armStallNudge(managed, 'session-1')
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)
    expect(getMock(managed).sentMessages).toHaveLength(1)

    armStallNudge(managed, 'session-1')
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(getMock(managed).sentMessages).toHaveLength(1)
  })

  it('does not fire for a stale session after a session swap', async () => {
    const managed = createManagedConnector({ sessionId: 'session-1' })
    armStallNudge(managed, 'session-1')
    managed.sessionId = 'session-2'

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(getMock(managed).sentMessages).toHaveLength(0)
  })

  it('keeps the latch set and does not throw when the send fails', async () => {
    const managed = createManagedConnector()
    vi.spyOn(managed.connector, 'sendMessage').mockRejectedValue(new Error('telegram down'))
    armStallNudge(managed, 'session-1')

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(managed.stallNotified).toBe(true)
  })

  it('never touches the indicator', async () => {
    const managed = createManagedConnector()
    const stopWorkingSpy = vi.spyOn(managed.connector, 'stopWorking')
    armStallNudge(managed, 'session-1')

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)

    expect(getMock(managed).workingActivities).toHaveLength(0)
    expect(stopWorkingSpy).not.toHaveBeenCalled()
    expect(managed.indicatorShown).toBeUndefined()
  })
})
