/**
 * An agent's live sessions and their container streams (`LiveSessions`):
 * subscribing and reattaching, the send boundary (`withSend`) and what a
 * failed send rolls back, an automation's stream released once it settles,
 * and how one agent's sessions stay apart from another's.
 *
 * The sessions are real (`attachLiveSessionsHarness`), fed frame by frame
 * through a stream client; what they hand the host is read off the
 * recording host port.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import type { ContainerInfo, StreamMessage } from '@shared/lib/container/types'

vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
}))
const mockRecordSessionActivity = vi.fn()
const mockRevertSessionActivity = vi.fn()
vi.mock('@shared/lib/services/session-summary-cache', () => ({
  recordSessionActivity: (...args: unknown[]) => mockRecordSessionActivity(...args),
  recordProvisionalSessionActivity: (_store: unknown, _id: string, at: number) => ({
    recordedAtMs: at,
    previous: { mtimeMs: at - 60_000, size: 10 },
  }),
  revertSessionActivity: (...args: unknown[]) => mockRevertSessionActivity(...args),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => ({}),
}))

import { attachLiveSessionsHarness, createStreamClient, type StreamClient } from '../testing/live-sessions-harness'
import type { SessionNotification } from '../host-port'
import { isQueuedSessionSend } from '@shared/lib/container/session-send-context'
import { getSessionMetadata } from '@shared/lib/services/session-service'

const live = attachLiveSessionsHarness()
const sessions = (slug: string = 'test-agent') => live.sessions(slug)

/** A whole stream message, with its own timestamp, on the client's stream. */
const deliver = (client: StreamClient, message: StreamMessage) =>
  vi.mocked(client.subscribeToStream).mock.calls.at(-1)![1](message)

/** The completion notifications the sessions sent the host. */
const completions = () =>
  live.host.sent('notification').filter((n): n is Extract<SessionNotification, { kind: 'session_complete' }> =>
    n.kind === 'session_complete')

// A turn's completion notification goes out once the transcript's end is
// known (an async stat); let that settle before asserting on it, either way.
const flushNotifications = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  live.reset()
  live.runtime.unexpectedDeath.mockReset()
  vi.clearAllMocks()
})

describe('LiveSessions', () => {
  const SESSION_ID = 'test-session-1'
  const AGENT_SLUG = 'test-agent'

  let mockClient: StreamClient
  let sseEvents: any[]
  let sseCleanup: () => void

  beforeEach(async () => {
    mockClient = createStreamClient()
    await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)

    const sse = live.collect(AGENT_SLUG, SESSION_ID)
    sseEvents = sse.events
    sseCleanup = sse.stop
  })

  afterEach(() => {
    sseCleanup()
    sessions().unsubscribe(SESSION_ID)
  })

  describe('withSend', () => {
    const emitResult = (subtype = 'success') => mockClient.emit({
      type: 'result', subtype, is_error: subtype !== 'success', num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const emitIdle = () => mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    const send = (delivery: () => Promise<void>) =>
      sessions().withSend(SESSION_ID, mockClient, delivery)

    beforeEach(() => {
      mockClient.emit({ type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'process-1' })
    })

    it('keeps queued automation delivery on the running connection and isolates the context by session', async () => {
      await send(async () => {
        expect(isQueuedSessionSend(AGENT_SLUG, SESSION_ID)).toBe(false)
      })
      await send(async () => {
        expect(isQueuedSessionSend(AGENT_SLUG, SESSION_ID)).toBe(true)
        expect(isQueuedSessionSend(AGENT_SLUG, 'other-session')).toBe(false)
        expect(isQueuedSessionSend('other-agent', SESSION_ID)).toBe(false)
      })
      expect(isQueuedSessionSend(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it.each(['before', 'after'] as const)('preserves an active turn when its final idle arrives %s a follow-up fails', async (timing) => {
      sessions().markActive(SESSION_ID)
      mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      emitResult()
      await expect(send(async () => {
        if (timing === 'before') emitIdle()
        throw new Error('HTTP 429')
      })).rejects.toThrow('HTTP 429')
      if (timing === 'after') {
        expect(sessions().isActive(SESSION_ID)).toBe(true)
        emitIdle()
      }
      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      await flushNotifications()
      expect(completions()).toHaveLength(1)
    })

    it('preserves a newer terminal result received during a failed follow-up', async () => {
      sessions().markActive(SESSION_ID)
      emitResult()
      await expect(send(async () => {
        emitResult('error_during_execution')
        emitIdle()
        throw new Error('send failed')
      })).rejects.toThrow('send failed')
      expect(sessions().isActive(SESSION_ID)).toBe(false)
      await flushNotifications()
      expect(completions()).toEqual([])
      expect(sseEvents.filter(e => e.type === 'session_error')).toHaveLength(1)
    })

    it('restores background waiting and settles when the last background task is stopped', async () => {
      vi.useFakeTimers()
      try {
        sessions().markActive(SESSION_ID)
        mockClient.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-task' }] })
        emitResult()
        emitIdle()
        await expect(send(async () => { throw new Error('send failed') })).rejects.toThrow('send failed')
        expect(sessions().isWaitingBackground(SESSION_ID)).toBe(true)
        mockClient.emit({ type: 'system', subtype: 'task_notification', task_id: 'bg-task', status: 'stopped' })
        await vi.advanceTimersByTimeAsync(1500)
        expect(sessions().isActive(SESSION_ID)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('preserves the stopped-task grace when a follow-up fails', async () => {
      vi.useFakeTimers()
      try {
        sessions().markActive(SESSION_ID)
        mockClient.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-task' }] })
        emitResult()
        emitIdle()
        mockClient.emit({ type: 'system', subtype: 'task_notification', task_id: 'bg-task', status: 'stopped' })
        await expect(send(async () => { throw new Error('send failed') })).rejects.toThrow('send failed')
        expect(sessions().isActive(SESSION_ID)).toBe(true)
        await vi.advanceTimersByTimeAsync(1500)
        expect(sessions().isActive(SESSION_ID)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('cleans up a rejected reconnect without activating or sending', async () => {
      sessions().unsubscribe(SESSION_ID)
      const unsubscribe = vi.fn()
      vi.mocked(mockClient.subscribeToStream).mockReturnValueOnce({
        unsubscribe, ready: Promise.reject(new Error('reconnect failed')),
      })
      const delivery = vi.fn(async () => {})
      await expect(send(delivery)).rejects.toThrow('reconnect failed')
      expect(delivery).not.toHaveBeenCalled()
      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
      expect(unsubscribe).toHaveBeenCalledOnce()
    })

    it('rolls back an unaccepted fresh send and its provisional recency', async () => {
      await expect(send(async () => { throw new Error('send failed') })).rejects.toThrow('send failed')
      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(mockRevertSessionActivity).toHaveBeenCalledOnce()
    })

    it.each(['assistant', 'stream_event'])('does not roll back accepted %s output after a failed HTTP response', async (type) => {
      await expect(send(async () => {
        mockClient.emit(type === 'assistant'
          ? { type, message: { role: 'assistant', content: 'Already running' } }
          : { type, event: { type: 'message_start', message: { id: 'new-message' } } })
        throw new Error('response lost')
      })).rejects.toThrow('response lost')
      expect(sessions().isActive(SESSION_ID)).toBe(true)
      expect(mockRevertSessionActivity).not.toHaveBeenCalled()
      emitResult()
      emitIdle()
      expect(sessions().isActive(SESSION_ID)).toBe(false)
    })

    it('rolls back overlapping failed deliveries without inheriting provisional activity', async () => {
      let rejectFirst!: (error: Error) => void
      const first = send(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject }))
      const secondDelivery = vi.fn(async () => { throw new Error('second failed') })
      const second = send(secondDelivery)
      expect(secondDelivery).not.toHaveBeenCalled()
      const failures = Promise.all([
        expect(first).rejects.toThrow('first failed'),
        expect(second).rejects.toThrow('second failed'),
      ])
      rejectFirst(new Error('first failed'))
      await failures
      expect(secondDelivery).toHaveBeenCalledOnce()
      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(mockRevertSessionActivity).toHaveBeenCalledTimes(2)
    })

    it('leaves a turn owned by recovery active when delivery fails', async () => {
      await expect(send(async () => {
        sessions().claimMidTurnForRecovery()
        throw new Error('connection lost during recovery')
      })).rejects.toThrow('connection lost during recovery')
      expect(sessions().isRecovering(SESSION_ID)).toBe(true)
      expect(sessions().isActive(SESSION_ID)).toBe(true)
      expect(mockRevertSessionActivity).not.toHaveBeenCalled()
    })

    it('does not roll back a newer send when an older delivery fails', async () => {
      await expect(send(async () => {
        sessions().markActive(SESSION_ID)
        throw new Error('older send failed')
      })).rejects.toThrow('older send failed')
      expect(sessions().isActive(SESSION_ID)).toBe(true)
      expect(mockRevertSessionActivity).not.toHaveBeenCalled()
    })

    it.each([
      { isScheduledExecution: true },
      { isWebhookExecution: true },
      { isChatIntegrationSession: true },
      { invokedByAgentSlug: 'caller' },
    ])('releases an unpromoted automation only after delivery and settlement (%j)', async (metadata) => {
      vi.mocked(getSessionMetadata).mockResolvedValue(metadata as never)
      try {
        await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
        await send(async () => {
          emitResult()
          emitIdle()
          expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
        })
        expect(sessions().isActive(SESSION_ID)).toBe(false)
        expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
      } finally {
        vi.mocked(getSessionMetadata).mockResolvedValue(null)
      }
    })

    it('remembers eviction during a failed send and releases its idle transport', async () => {
      vi.mocked(getSessionMetadata).mockResolvedValue({ isChatIntegrationSession: true } as never)
      try {
        await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
        await expect(send(async () => {
          mockClient.emit({ type: 'system', subtype: 'process_evicted', process_instance: 'process-1' })
          expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
          throw new Error('send failed')
        })).rejects.toThrow('send failed')
        expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
      } finally {
        vi.mocked(getSessionMetadata).mockResolvedValue(null)
      }
    })

    it.each([
      { isChatIntegrationSession: true },
      { isScheduledExecution: true },
      { isWebhookExecution: true },
      { invokedByAgentSlug: 'caller' },
    ])('keeps the new reply subscribed when terminal replay arrives after WebSocket open (%j)', async (metadata) => {
      // Exercise the real client's readiness contract: the server opens the
      // socket and sends capabilities, then delays its replay and acknowledgement.
      const { BaseContainerClient } = await import('@shared/lib/container/base-container-client')
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
      await new Promise<void>(resolve => server.once('listening', resolve))
      const address = server.address() as { port: number }
      class ReplayClient extends BaseContainerClient {
        protected getRunnerCommand() { return 'docker' }
        async getInfoFromRuntime(): Promise<ContainerInfo> {
          return { status: 'running', port: address.port }
        }
        getHostAuthHeaders() { return {} }
      }
      const client = new ReplayClient({ agentId: AGENT_SLUG })
      const socketConnected = new Promise<import('ws').WebSocket>(resolve => {
        server.once('connection', socket => {
          socket.send(JSON.stringify({ type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'process-1' }))
          resolve(socket)
        })
      })
      const capabilitiesReceived = new Promise<void>(resolve => client.once('message', () => resolve()))
      let acceptDelivery!: () => void
      const deliveryAccepted = new Promise<void>(resolve => { acceptDelivery = resolve })
      let sendStarted!: () => void
      const deliveryStarted = new Promise<void>(resolve => { sendStarted = resolve })
      let pendingSend: Promise<void> | undefined
      vi.mocked(getSessionMetadata).mockResolvedValue(metadata as never)
      try {
        await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
        await send(async () => { emitResult(); emitIdle() })
        expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
        const idleEventsBefore = sseEvents.filter(e => e.type === 'session_idle').length
        pendingSend = sessions().withSend(SESSION_ID, client, async () => {
          sendStarted()
          await deliveryAccepted
        })
        const socket = await socketConnected
        await capabilitiesReceived
        const replayReceived = new Promise<void>(resolve => {
          const onMessage = (_id: string, message: { type: string }) => {
            if (message.type === 'status') {
              client.off('message', onMessage)
              resolve()
            }
          }
          client.on('message', onMessage)
        })
        socket.send(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, replayed: true }))
        socket.send(JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle', replayed: true }))
        socket.send(JSON.stringify({ type: 'status', data: { message: 'Connected to session stream' } }))
        await replayReceived
        await deliveryStarted
        acceptDelivery()
        await pendingSend
        expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
        expect(sessions().isActive(SESSION_ID)).toBe(true)
        expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(idleEventsBefore)

        const replyReceived = new Promise<void>(resolve => {
          const onMessage = (_id: string, message: { state?: string }) => {
            if (message.state === 'idle') {
              client.off('message', onMessage)
              resolve()
            }
          }
          client.on('message', onMessage)
        })
        socket.send(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'The new reply' } }))
        socket.send(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }))
        socket.send(JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' }))
        await replyReceived
        await flushNotifications()
        expect(completions().at(-1)).toMatchObject({ sessionId: SESSION_ID, agentSlug: AGENT_SLUG, responseText: 'The new reply' })
        expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
      } finally {
        acceptDelivery()
        sessions().unsubscribe(SESSION_ID)
        await pendingSend?.catch(() => {})
        for (const socket of server.clients) socket.terminate()
        await new Promise<void>(resolve => server.close(() => resolve()))
        vi.mocked(getSessionMetadata).mockResolvedValue(null)
      }
    })

    it('subscribes again on the next send after the stream closed while idle', async () => {
      await send(async () => {
        mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
        emitResult()
        emitIdle()
      })
      expect(sessions().isActive(SESSION_ID)).toBe(false)

      vi.mocked(mockClient.getSession).mockResolvedValueOnce({ isRunning: false } as never)
      mockClient.emit({ type: 'connection_closed' })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(sessions().isSubscribed(SESSION_ID)).toBe(false)

      const subscribesBefore = vi.mocked(mockClient.subscribeToStream).mock.calls.length
      await send(async () => {})
      expect(mockClient.subscribeToStream).toHaveBeenCalledTimes(subscribesBefore + 1)
      expect(sessions().isActive(SESSION_ID)).toBe(true)

      const idleEventsBefore = sseEvents.filter(e => e.type === 'session_idle').length
      mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      emitResult()
      emitIdle()
      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(idleEventsBefore + 1)
    })

    it.each(['explicit', 'automatic'])('waits for an %s attachment already in progress before sending', async (mode) => {
      const subscribe = vi.mocked(mockClient.subscribeToStream).getMockImplementation()!
      let finishReplay!: () => void
      vi.mocked(mockClient.subscribeToStream).mockImplementationOnce((...args) => ({
        ...subscribe(...args),
        ready: new Promise<void>(resolve => { finishReplay = resolve }),
      }))
      let subscription: Promise<void> | undefined
      if (mode === 'explicit') {
        subscription = sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
      } else {
        vi.mocked(mockClient.getSession).mockResolvedValueOnce({ isRunning: true } as never)
        mockClient.emit({ type: 'connection_closed' })
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      const delivery = vi.fn(async () => {})
      const pendingSend = send(delivery)
      try {
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(delivery).not.toHaveBeenCalled()
      } finally {
        finishReplay()
        await Promise.all([subscription, pendingSend])
      }
      expect(delivery).toHaveBeenCalledOnce()
      expect(sessions().isActive(SESSION_ID)).toBe(true)
    })

    it('reconnects before activating a new turn and ignores the previous terminal replay', async () => {
      vi.mocked(getSessionMetadata).mockResolvedValue({ isChatIntegrationSession: true } as never)
      try {
        await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
        await send(async () => { emitResult(); emitIdle() })
        expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
        const subscribe = vi.mocked(mockClient.subscribeToStream).getMockImplementation()!
        vi.mocked(mockClient.subscribeToStream).mockImplementationOnce((...args) => {
          const subscription = subscribe(...args)
          return { ...subscription, ready: Promise.resolve().then(() => {
            mockClient.emit({ type: 'result', subtype: 'success', is_error: false, replayed: true })
            mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle', replayed: true })
          }) }
        })
        const idleEventsBefore = sseEvents.filter(e => e.type === 'session_idle').length
        await send(async () => {
          expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
          expect(sessions().isActive(SESSION_ID)).toBe(true)
          expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(idleEventsBefore)
        })
      } finally {
        vi.mocked(getSessionMetadata).mockResolvedValue(null)
      }
    })
  })

  // ============================================================================
  // subscribeToSession preserves isActive (sync x-agent invoke race fix)
  // ============================================================================

  describe('subscribe state preservation', () => {
    const PRESERVE_SESSION = 'preserve-session'

    afterEach(() => {
      sessions().unsubscribe(PRESERVE_SESSION)
    })

    it('preserves isActive=true from prior state when (re-)subscribing', async () => {
      // Caller marks active before subscribing (x-agent sync invoke pattern)
      sessions().markActive(PRESERVE_SESSION)
      expect(sessions().isActive(PRESERVE_SESSION)).toBe(true)

      const client = createStreamClient()
      await sessions().subscribe(PRESERVE_SESSION, client, PRESERVE_SESSION)

      // Without preservation, isActive would be reset to false here
      expect(sessions().isActive(PRESERVE_SESSION)).toBe(true)
    })

    it('defaults isActive=false when subscribing fresh (no prior state)', async () => {
      const client = createStreamClient()
      await sessions().subscribe(PRESERVE_SESSION, client, PRESERVE_SESSION)
      expect(sessions().isActive(PRESERVE_SESSION)).toBe(false)
    })

    it('concurrent subscribeToSession calls share the in-flight subscription (no double-init)', async () => {
      const client = createStreamClient()
      const subscribeSpy = client.subscribeToStream as ReturnType<typeof vi.fn>
      // Fire two concurrent subscribes for the same session before either resolves
      const p1 = sessions().subscribe(PRESERVE_SESSION, client, PRESERVE_SESSION)
      const p2 = sessions().subscribe(PRESERVE_SESSION, client, PRESERVE_SESSION)
      await Promise.all([p1, p2])
      // Underlying transport subscription must only happen once
      expect(subscribeSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('dispose', () => {
    it('ends a session still mid-turn the way a container stop does, then drops its stream', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      sessions().markActive(SESSION_ID)
      const unsubscribe = vi.mocked(mockClient.subscribeToStream).mock.results.at(-1)!.value.unsubscribe

      sessions().dispose()

      expect(sseEvents.at(-1)).toMatchObject({ type: 'session_error', terminalReason: 'connection_lost', isActive: false })
      expect(live.host.sent('global')).toContainEqual(expect.objectContaining({ type: 'session_error', sessionId: SESSION_ID }))
      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(unsubscribe).toHaveBeenCalled()
    })

    it('says nothing for a session that was idle', () => {
      const before = sseEvents.length
      sessions().dispose()
      expect(sseEvents.length).toBe(before)
    })
  })

  describe('automation stream release on settle (SUP-572)', () => {
    // A leaked stream per cron/webhook run holds a runtime-container WebSocket
    // open forever (keepalives defeat idle cuts); runtimes that cap concurrent
    // connections per container then block new sessions. The sessions must
    // release the stream once an unpromoted automation session truly settles.

    afterEach(() => {
      // mockResolvedValue survives clearAllMocks — restore the suite default.
      vi.mocked(getSessionMetadata).mockImplementation(() => Promise.resolve(null))
    })

    // Re-subscribe AFTER pointing the metadata mock at the desired session
    // shape, then let the async subscribe-time resolution land.
    async function resubscribeWithMetadata(meta: Record<string, unknown> | null) {
      vi.mocked(getSessionMetadata).mockResolvedValue(meta as never)
      await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    function settleSession() {
      sessions().markActive(SESSION_ID)
      // State-events authority: the runtime's own idle proves the queue drained.
      mockClient.emit({ type: 'system', subtype: 'capabilities', session_state_events: true })
      mockClient.emit({
        type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    }

    it('releases the stream when a scheduled session settles', async () => {
      await resubscribeWithMetadata({ isScheduledExecution: true, scheduledTaskId: 'task-1' })

      settleSession()

      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
      const lastSubscription = vi.mocked(mockClient.subscribeToStream).mock.results.at(-1)!
        .value as { unsubscribe: ReturnType<typeof vi.fn> }
      expect(lastSubscription.unsubscribe).toHaveBeenCalled()
    })

    it('releases the stream when a scheduled session settles with an error', async () => {
      await resubscribeWithMetadata({ isScheduledExecution: true, scheduledTaskId: 'task-1' })

      sessions().markActive(SESSION_ID)
      mockClient.emit({ type: 'system', subtype: 'capabilities', session_state_events: true })
      mockClient.emit({
        type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 100, num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 0 },
      })
      mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
    })

    it('releases the stream when a webhook session settles', async () => {
      await resubscribeWithMetadata({ isWebhookExecution: true, webhookTriggerId: 'trigger-1' })

      settleSession()

      expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
    })

    it('releases the stream when an x-agent session settles', async () => {
      await resubscribeWithMetadata({ invokedByAgentSlug: 'caller-agent' })

      settleSession()

      expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
    })

    function announceProcess(processInstance = 'process-1') {
      mockClient.emit({
        type: 'system', subtype: 'capabilities', session_state_events: true,
        process_instance: processInstance,
      })
    }

    function evictProcess(processInstance = 'process-1') {
      mockClient.emit({ type: 'system', subtype: 'process_evicted', process_instance: processInstance })
    }

    it.each([{ isChatIntegrationSession: true }, { isAgentIntegrationSession: true }])('releases only an integration transport when its turn settles (%j)', async metadata => {
      await resubscribeWithMetadata(metadata)
      announceProcess()
      const teardown = vi.spyOn(sessions(), 'unsubscribe')
      settleSession()
      expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
      expect(teardown).not.toHaveBeenCalled()
      expect(live.runtime.unexpectedDeath).not.toHaveBeenCalled()
      const subscription = vi.mocked(mockClient.subscribeToStream).mock.results.at(-1)!.value
      expect(subscription.unsubscribe).toHaveBeenCalledTimes(1)
      teardown.mockRestore()
    })

    it.each([null, { isChatIntegrationSession: true, promotedToInteractive: true }])(
      'retains interactive or promoted streams on eviction (%j)', async (metadata) => {
        await resubscribeWithMetadata(metadata)
        announceProcess()
        settleSession()
        evictProcess()
        expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
      },
    )

    it('does not detach for an older process or a new turn racing eviction', async () => {
      await resubscribeWithMetadata({ isChatIntegrationSession: true })
      announceProcess()
      evictProcess('older-process')
      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
      sessions().markActive(SESSION_ID)
      evictProcess()
      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
      expect(sessions().isActive(SESSION_ID)).toBe(true)
    })

    it.each(['isAwaitingInput', 'isRecovering'] as const)('retains a chat transport while %s', async (hold) => {
      await resubscribeWithMetadata({ isChatIntegrationSession: true })
      announceProcess()
      const states = (sessions() as unknown as {
        states: Map<string, { isAwaitingInput: boolean; isRecovering: boolean }>
      }).states
      states.get(SESSION_ID)![hold] = true
      evictProcess()
      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
    })

    it('retains a chat transport with background work even if foreground is idle', async () => {
      await resubscribeWithMetadata({ isChatIntegrationSession: true })
      announceProcess()
      mockClient.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'background-task' }] })
      evictProcess()
      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
    })

    it('retains an evicted chat stream after promotion', async () => {
      await resubscribeWithMetadata({ isChatIntegrationSession: true })
      announceProcess()
      await sessions().promoteAutomated(SESSION_ID)
      evictProcess()
      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
    })

    it('releases chat transports on repeated settlement and receives output after reconnect', async () => {
      await resubscribeWithMetadata({ isChatIntegrationSession: true })
      const events: unknown[] = []
      const removeListener = sessions().listen(SESSION_ID, (event) => events.push(event))
      for (let cycle = 0; cycle < 12; cycle++) {
        announceProcess(`process-${cycle}`)
        settleSession()
        evictProcess(`process-${cycle}`)
        expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
        sessions().markActive(SESSION_ID)
        await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
        expect(sessions().isActive(SESSION_ID)).toBe(true)
        expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
        mockClient.emit({ type: 'system', subtype: 'init', slash_commands: [] })
        expect(events.at(-1)).toMatchObject({ type: 'stream_start' })
      }
      removeListener()
    })

    it('keeps the stream for an interactive session', async () => {
      await resubscribeWithMetadata(null)

      settleSession()

      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
    })

    it('keeps the stream for a promoted automation session', async () => {
      await resubscribeWithMetadata({ isScheduledExecution: true, promotedToInteractive: true })

      settleSession()

      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
    })

    it('keeps the stream when a scheduled session is promoted mid-run', async () => {
      await resubscribeWithMetadata({ isScheduledExecution: true, scheduledTaskId: 'task-1' })

      await sessions().promoteAutomated(SESSION_ID)

      settleSession()

      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
    })

    it('does not let a stale subscribe-time metadata read undo a promotion', async () => {
      const unpromoted = { isScheduledExecution: true, scheduledTaskId: 'task-1' }
      let resolveSubscribeMeta: ((value: typeof unpromoted) => void) | undefined
      let metaCalls = 0
      vi.mocked(getSessionMetadata).mockImplementation(() => {
        metaCalls += 1
        if (metaCalls === 1) {
          return new Promise((resolve) => { resolveSubscribeMeta = resolve })
        }
        return Promise.resolve(unpromoted as never)
      })

      await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
      await sessions().promoteAutomated(SESSION_ID)
      resolveSubscribeMeta!(unpromoted)
      await new Promise((resolve) => setTimeout(resolve, 0))

      settleSession()

      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
    })

    it('does not release on a legacy result-driven idle (no state-events authority)', async () => {
      // Without the runtime's own idle event there is no proof the container's
      // message queue is drained — a queued message could still start a turn
      // on this stream, so the release must not fire.
      await resubscribeWithMetadata({ isScheduledExecution: true, scheduledTaskId: 'task-1' })

      sessions().markActive(SESSION_ID)
      mockClient.emit({
        type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })

      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
    })

    it('releases when automation metadata resolves after the turn already settled', async () => {
      let resolveMetadata!: (value: never) => void
      vi.mocked(getSessionMetadata).mockImplementationOnce(() => new Promise(resolve => { resolveMetadata = resolve }))
      await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
      settleSession()
      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
      resolveMetadata({ invokedByAgentSlug: 'caller' } as never)
      await vi.waitFor(() => expect(sessions().isSubscribed(SESSION_ID)).toBe(false))
    })

    it('does not use an older idle as settlement for a newer error result', async () => {
      settleSession()
      let resolveMetadata!: (value: never) => void
      vi.mocked(getSessionMetadata).mockImplementationOnce(() => new Promise(resolve => { resolveMetadata = resolve }))
      await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
      sessions().markActive(SESSION_ID)
      mockClient.emit({ type: 'result', subtype: 'error_during_execution', is_error: true })
      resolveMetadata({ isChatIntegrationSession: true } as never)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
      mockClient.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
    })

    it.each([
      { isScheduledExecution: true }, { isWebhookExecution: true },
      { isChatIntegrationSession: true }, { invokedByAgentSlug: 'caller' },
    ])('retains every promoted automation category (%j)', async (metadata) => {
      await resubscribeWithMetadata({ ...metadata, promotedToInteractive: true })
      announceProcess()
      settleSession()
      evictProcess()
      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)
    })

    it('a released session re-subscribes cleanly for a later wake', async () => {
      await resubscribeWithMetadata({ isScheduledExecution: true, scheduledTaskId: 'task-1' })
      settleSession()
      expect(sessions().isSubscribed(SESSION_ID)).toBe(false)

      // The wake path checks isSubscribed and re-subscribes on demand.
      await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)
      expect(sessions().isSubscribed(SESSION_ID)).toBe(true)

      // And the resumed run releases again at its own settle.
      await new Promise((resolve) => setTimeout(resolve, 0))
      settleSession()
      expect(sessions().isSubscribed(SESSION_ID)).toBe(false)
    })
  })
})

// ===========================================================================
// Cross-agent isolation of the agents' live sessions.
//
// Each agent's sessions are its own (`LiveSessions` on its actor's state),
// keyed by session id alone. These tests pin the property that has to
// deliver: work done on one agent's session is never observable on another
// agent's.
//
// The agent-scoped queries below (`activeIds`, `hasActive`, `markAllInactive`,
// `claimMidTurnForRecovery`) are the recovery and container-lifecycle paths —
// the ones where a mix-up would show up as a session that silently fails to
// resume rather than as a crash.
// ===========================================================================
describe('cross-agent isolation', () => {
  const AGENT_A = 'agent-alpha'
  const AGENT_B = 'agent-beta'
  const SESSION_A1 = 'alpha-session-1'
  const SESSION_A2 = 'alpha-session-2'
  const SESSION_B1 = 'beta-session-1'

  let clientA1: StreamClient
  let clientA2: StreamClient
  let clientB1: StreamClient

  beforeEach(async () => {
    clientA1 = createStreamClient()
    clientA2 = createStreamClient()
    clientB1 = createStreamClient()
    await sessions(AGENT_A).subscribe(SESSION_A1, clientA1, SESSION_A1)
    await sessions(AGENT_A).subscribe(SESSION_A2, clientA2, SESSION_A2)
    await sessions(AGENT_B).subscribe(SESSION_B1, clientB1, SESSION_B1)
  })

  afterEach(() => {
    for (const id of [SESSION_A1, SESSION_A2, SESSION_B1]) {
      sessions(id === SESSION_B1 ? AGENT_B : AGENT_A).unsubscribe(id)
    }
  })

  describe('agent-scoped queries', () => {
    it('reports active sessions only for the agent that owns them', () => {
      sessions(AGENT_A).markActive(SESSION_A1)
      sessions(AGENT_B).markActive(SESSION_B1)

      expect(sessions(AGENT_A).activeIds()).toEqual([SESSION_A1])
      expect(sessions(AGENT_B).activeIds()).toEqual([SESSION_B1])
      expect(sessions(AGENT_A).hasActive()).toBe(true)
      expect(sessions(AGENT_B).hasActive()).toBe(true)
      expect(sessions('agent-with-nothing').hasActive()).toBe(false)
    })

    it('reports awaiting-input only for the agent that owns the session', () => {
      sessions(AGENT_A).markActive(SESSION_A1)

      expect(sessions(AGENT_B).hasAwaitingInput()).toBe(false)
    })

    it('stopping one agent’s container leaves the other agent’s sessions alone', () => {
      sessions(AGENT_A).markActive(SESSION_A1)
      sessions(AGENT_A).markActive(SESSION_A2)
      sessions(AGENT_B).markActive(SESSION_B1)

      sessions(AGENT_A).markAllInactive()

      expect(sessions(AGENT_A).isActive(SESSION_A1)).toBe(false)
      expect(sessions(AGENT_A).isActive(SESSION_A2)).toBe(false)
      expect(sessions(AGENT_B).isActive(SESSION_B1)).toBe(true)
      expect(sessions(AGENT_B).isSubscribed(SESSION_B1)).toBe(true)
    })

    it('snapshots mid-turn sessions only for the named agent', () => {
      sessions(AGENT_A).markActive(SESSION_A1)
      sessions(AGENT_B).markActive(SESSION_B1)

      expect(sessions(AGENT_A).claimMidTurnForRecovery()).toEqual([SESSION_A1])
      expect(sessions(AGENT_B).isRecovering(SESSION_B1)).toBe(false)
    })

    it('honours the restrict list within an agent', () => {
      sessions(AGENT_A).markActive(SESSION_A1)
      sessions(AGENT_A).markActive(SESSION_A2)

      expect(sessions(AGENT_A).claimMidTurnForRecovery([SESSION_A2])).toEqual([SESSION_A2])
      expect(sessions(AGENT_A).isRecovering(SESSION_A1)).toBe(false)
      expect(sessions(AGENT_A).isRecovering(SESSION_A2)).toBe(true)
    })

    it('never snapshots another agent’s session even when it is named in the restrict list', () => {
      sessions(AGENT_A).markActive(SESSION_A1)
      sessions(AGENT_B).markActive(SESSION_B1)

      expect(sessions(AGENT_A).claimMidTurnForRecovery([SESSION_B1])).toEqual([])
      expect(sessions(AGENT_B).isRecovering(SESSION_B1)).toBe(false)
    })
  })

  describe('per-session state does not bleed', () => {
    it('delivers SSE events only to the subscribers of that session', () => {
      const a1 = live.collect(AGENT_A, SESSION_A1)
      const b1 = live.collect(AGENT_B, SESSION_B1)
      try {
        sessions(AGENT_B).emit(SESSION_B1, { type: 'user_typing' })

        expect(b1.events).toContainEqual(expect.objectContaining({ type: 'user_typing' }))
        expect(a1.events).toEqual([])
      } finally {
        a1.stop()
        b1.stop()
      }
    })

    it('interrupting one session does not settle another agent’s session', async () => {
      sessions(AGENT_A).markActive(SESSION_A1)
      sessions(AGENT_B).markActive(SESSION_B1)

      sessions(AGENT_A).markInterrupted(SESSION_A1)

      expect(sessions(AGENT_A).isActive(SESSION_A1)).toBe(false)
      expect(sessions(AGENT_B).isActive(SESSION_B1)).toBe(true)
    })

    it('unsubscribing one session leaves the other agent’s subscription intact', () => {
      sessions(AGENT_A).unsubscribe(SESSION_A1)

      expect(sessions(AGENT_A).isSubscribed(SESSION_A1)).toBe(false)
      expect(sessions(AGENT_B).isSubscribed(SESSION_B1)).toBe(true)
    })

    it('keeps slash commands per session', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessions(AGENT_A).setSlashCommands(SESSION_A1, [{ name: 'alpha-only' }] as any)

      expect(sessions(AGENT_A).slashCommands(SESSION_A1)).toEqual([{ name: 'alpha-only' }])
      expect(sessions(AGENT_B).slashCommands(SESSION_B1)).toEqual([])
    })

    it('keeps capability grants per session', () => {
      sessions(AGENT_A).grantCapability(SESSION_A1, 'subagents')

      expect(sessions(AGENT_A).capabilityGranted(SESSION_A1, 'subagents')).toBe(true)
      expect(sessions(AGENT_B).capabilityGranted(SESSION_B1, 'subagents')).toBe(false)
    })

    it('attributes a streamed frame to the agent that owns the session', () => {
      const timestamp = new Date('2026-08-30T10:00:00.000Z')

      deliver(clientB1, {
        type: 'message',
        content: { type: 'assistant', message: { role: 'assistant', content: 'from beta' } },
        timestamp,
        sessionId: SESSION_B1,
      })

      expect(mockRecordSessionActivity).toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_B }), SESSION_B1, timestamp)
      expect(mockRecordSessionActivity).not.toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_A }), SESSION_B1, timestamp)
    })
  })
})
