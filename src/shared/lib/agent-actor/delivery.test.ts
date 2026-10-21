/**
 * The actor's multi-step session ops (`delivery.ts`): a message's delivery,
 * a session's start, its attach and its stop, each one op over the agent's
 * real live sessions, an in-memory session store with the real session
 * service, and a container client double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => settings.value,
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => ({}),
}))
vi.mock('@shared/lib/services/session-summary-cache', () => ({
  recordSessionActivity: vi.fn(),
  recordProvisionalSessionActivity: (_store: unknown, _id: string, at: number) => ({ recordedAtMs: at, previous: null }),
  revertSessionActivity: vi.fn(),
}))

import * as sessionService from '@shared/lib/services/session-service'
import { MessageNotAcceptedError } from '@shared/lib/container/message-dispatch-error'
import type { ContainerClient, StreamMessage } from '@shared/lib/container/types'
import { createSessionDelivery } from './delivery'
import { deliveryFailure, startFailure } from './delivery-errors'
import { attachLiveSessionsHarness, createStreamClient, type StreamClient } from './testing/live-sessions-harness'

const SLUG = 'agent'
const SESSION = 'session-1'

const live = attachLiveSessionsHarness()
let client: StreamClient
let running: boolean
const runtime = {
  getClient: () => client as ContainerClient,
  ensureRunning: vi.fn(async () => client as ContainerClient),
  getCachedInfo: () => ({ status: running ? 'running' : 'stopped' }),
}
const recordSessionActivity = vi.fn()
const denyAllForAgent = vi.fn()
// The real session service, as an object a test can spy on.
const service = { ...sessionService }

const sessions = () => live.sessions(SLUG)
const store = () => live.store(SLUG)
const delivery = () =>
  createSessionDelivery(SLUG, store(), sessions(), {
    containerHost: { runtime: () => runtime } as never,
    sessionService: service,
    recordSessionActivity,
    reviewManager: { denyAllForAgent } as never,
    host: live.host.port,
  })
const metadata = () => sessionService.getSessionMetadata(store(), SESSION)
const send = () => vi.mocked(client.sendMessage)

beforeEach(async () => {
  client = createStreamClient()
  running = true
  settings.value = {}
  send().mockResolvedValue({})
  await sessionService.registerSession(store(), SESSION, 'Session', { model: 'model-a', llmProviderId: 'conn-a' })
})

afterEach(() => {
  live.reset()
  vi.clearAllMocks()
})

describe('deliver', () => {
  it('starts a fresh turn: attaches, marks, echoes unqueued, then sends with the read it made', async () => {
    const events = live.collect(SLUG, SESSION).events
    send().mockImplementation(async () => {
      expect(sessions().isActive(SESSION)).toBe(true)
      expect(events.find((event) => event.type === 'user_message')).toMatchObject({ uuid: 'm1', queued: false, content: 'hi' })
      return {}
    })

    expect(await delivery().deliver({ sessionId: SESSION, content: 'hi', uuid: 'm1', echo: { content: 'hi' } }))
      .toEqual({ status: 'sent', queued: false })
    expect(runtime.ensureRunning).toHaveBeenCalledOnce()
    expect(sessions().isSubscribed(SESSION)).toBe(true)
    expect(send()).toHaveBeenCalledExactlyOnceWith(SESSION, 'hi', 'm1', {
      sessionMetadata: expect.objectContaining({ model: 'model-a', name: 'Session' }),
      metadataUpdates: {},
    })
  })

  it('joins a running turn without its runtime, and keeps the turn\'s', async () => {
    await delivery().attach(SESSION)
    sessions().markActive(SESSION)
    const events = live.collect(SLUG, SESSION).events

    expect(await delivery().deliver({
      sessionId: SESSION,
      content: 'and then',
      uuid: 'm2',
      options: { model: 'model-b', llmProviderId: 'conn-b', effort: 'high', speed: 'fast' },
      echo: { content: 'and then' },
    })).toEqual({ status: 'sent', queued: true })
    expect(send()).toHaveBeenCalledWith(SESSION, 'and then', 'm2', expect.objectContaining({ preserveRuntime: true, metadataUpdates: {} }))
    expect(send().mock.calls[0][3]).not.toHaveProperty('model')
    expect(send().mock.calls[0][3]).not.toHaveProperty('effort')
    expect(events.find((event) => event.type === 'user_message')).toMatchObject({ uuid: 'm2', queued: true })
    expect(await metadata()).toMatchObject({ model: 'model-a', llmProviderId: 'conn-a' })
    expect(await metadata()).not.toHaveProperty('effort')
  })

  it('appends to the transcript without a turn: nothing is cancelled or marked', async () => {
    const cancel = vi.spyOn(sessions(), 'cancelAwaitingInput')

    expect(await delivery().deliver({
      sessionId: SESSION, content: '[SYSTEM] note', uuid: 'm3', options: { shouldQuery: false, model: 'model-b' }, cancelAwaiting: true,
    })).toEqual({ status: 'sent', queued: false })
    expect(sessions().isActive(SESSION)).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
    expect(send()).toHaveBeenCalledExactlyOnceWith(SESSION, '[SYSTEM] note', 'm3', { shouldQuery: false, preserveRuntime: true })
    expect(recordSessionActivity).toHaveBeenCalledWith(store(), SESSION)
  })

  it('cancels what the session waits on before it decides the message is queued', async () => {
    await delivery().attach(SESSION)
    sessions().markActive(SESSION)
    const cancel = vi.spyOn(sessions(), 'cancelAwaitingInput').mockImplementation(async () => {
      sessions().markInterrupted(SESSION)
    })

    expect(await delivery().deliver({ sessionId: SESSION, content: 'new question', cancelAwaiting: true }))
      .toEqual({ status: 'sent', queued: false })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('holds a message while the session recovers, and shows it queued', async () => {
    await delivery().attach(SESSION)
    sessions().markActive(SESSION)
    sessions().claimMidTurnForRecovery()
    const events = live.collect(SLUG, SESSION).events

    expect(await delivery().deliver({ sessionId: SESSION, content: 'still there?', uuid: 'm4', coalesce: true, echo: { content: 'still there?' } }))
      .toEqual({ status: 'coalesced' })
    expect(send()).not.toHaveBeenCalled()
    expect(runtime.ensureRunning).not.toHaveBeenCalled()
    expect(events.find((event) => event.type === 'user_message')).toMatchObject({ uuid: 'm4', queued: true })
    expect(sessions().takeCoalesced(SESSION)).toEqual([{ uuid: 'm4', text: 'still there?' }])
  })

  it('holds a recovering session\'s message only once it passed the provider check', async () => {
    await delivery().attach(SESSION)
    sessions().markActive(SESSION)
    sessions().claimMidTurnForRecovery()

    const error = await delivery()
      .deliver({ sessionId: SESSION, content: 'x', uuid: 'm5', coalesce: true, options: { llmProviderId: 'conn-b' }, requireStoredProvider: true })
      .catch((caught: unknown) => caught)
    expect(deliveryFailure(error)).toEqual({ code: 'provider-not-attached', accepted: false })
    expect(sessions().takeCoalesced(SESSION)).toEqual([])
  })

  it('holds a recovering session\'s messages in their delivery turns, in the order they came', async () => {
    await delivery().attach(SESSION)
    sessions().markActive(SESSION)
    sessions().claimMidTurnForRecovery()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = vi.spyOn(service, 'getSessionMetadata').mockImplementationOnce(async (...args) => {
      await gate
      return sessionService.getSessionMetadata(...args)
    })

    const first = delivery().deliver({ sessionId: SESSION, content: 'one', uuid: 'a', coalesce: true })
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    const second = delivery().deliver({ sessionId: SESSION, content: 'two', uuid: 'b', coalesce: true })
    release()
    await Promise.all([first, second])

    expect(sessions().takeCoalesced(SESSION).map((message) => message.uuid)).toEqual(['a', 'b'])
  })

  it('refuses to join a running turn when asked to deliver only into an idle session', async () => {
    await delivery().attach(SESSION)
    sessions().markActive(SESSION)

    expect(await delivery().deliver({ sessionId: SESSION, content: 'follow-up', ifIdle: true })).toEqual({ status: 'busy' })
    expect(send()).not.toHaveBeenCalled()
  })

  it('refuses to join a running turn that only the attach reveals', async () => {
    // Not attached (an automation's stream is released once idle), while the
    // container runs a turn the host has not heard of: a background task's wake.
    vi.mocked(client.subscribeToStream).mockImplementationOnce((_id: string, onMessage: (message: StreamMessage) => void) => {
      onMessage({ type: 'message', content: { type: 'system', subtype: 'session_state_changed', state: 'running' }, timestamp: new Date(), sessionId: SESSION })
      return { unsubscribe: vi.fn(), ready: Promise.resolve() }
    })
    expect(sessions().isActive(SESSION)).toBe(false)

    expect(await delivery().deliver({ sessionId: SESSION, content: 'follow-up', ifIdle: true })).toEqual({ status: 'busy' })
    expect(send()).not.toHaveBeenCalled()
  })

  it('sends only once an attach in flight is done: the turn\'s first frames have a listener', async () => {
    let ready!: () => void
    vi.mocked(client.subscribeToStream).mockImplementation(() => ({
      unsubscribe: vi.fn(),
      ready: new Promise<void>((resolve) => {
        ready = resolve
      }),
    }))
    // The delivery's turn starts first, and is reading the session ...
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = vi.spyOn(service, 'getSessionMetadata').mockImplementationOnce(async (...args) => {
      await gate
      return sessionService.getSessionMetadata(...args)
    })
    const delivering = delivery().deliver({ sessionId: SESSION, content: 'hi' })
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    // ... when another caller starts an attach (a socket's reattach, an integration's replay).
    const attaching = delivery().attach(SESSION)
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(send()).not.toHaveBeenCalled()

    ready()
    await Promise.all([delivering, attaching])
    expect(send()).toHaveBeenCalledOnce()
    expect(client.subscribeToStream).toHaveBeenCalledOnce()
  })

  it('refuses another member\'s connection once the session no longer holds it', async () => {
    const error = await delivery()
      .deliver({ sessionId: SESSION, content: 'hi', options: { llmProviderId: 'conn-b' }, requireStoredProvider: true })
      .catch((caught: unknown) => caught)
    expect(deliveryFailure(error)).toEqual({ code: 'provider-not-attached', accepted: false })
    expect(send()).not.toHaveBeenCalled()
    expect(sessions().isActive(SESSION)).toBe(false)

    await delivery().deliver({ sessionId: SESSION, content: 'hi', options: { llmProviderId: 'conn-a' }, requireStoredProvider: true })
    expect(send()).toHaveBeenCalledOnce()
  })

  it('appends to the transcript whatever connection the caller names: an append uses none', async () => {
    await delivery().deliver({ sessionId: SESSION, content: 'note', options: { llmProviderId: 'conn-b', shouldQuery: false }, requireStoredProvider: true })

    expect(send()).toHaveBeenCalledExactlyOnceWith(SESSION, 'note', undefined, { shouldQuery: false, preserveRuntime: true })
  })

  it('rolls back its own mark when the container refuses the message, with the container\'s status', async () => {
    send().mockRejectedValueOnce(Object.assign(new MessageNotAcceptedError('rejected', 'Session is busy'), { status: 409 }))

    const error = await delivery().deliver({ sessionId: SESSION, content: 'hi' }).catch((caught: unknown) => caught)
    expect(deliveryFailure(error)).toEqual({ code: 'rejected', accepted: false, status: 409 })
    expect(sessions().isActive(SESSION)).toBe(false)
  })

  it.each([
    ['runs it', { id: SESSION, isRunning: true }, true],
    ['is not running it', { id: SESSION, isRunning: false }, false],
    ['does not know the session', null, false],
    ['cannot be asked', new Error('unreachable'), true],
  ])('after a send that may have gone, keeps the mark only while the container may run it (it %s)', async (_case, session, active) => {
    send().mockRejectedValueOnce(new Error('socket hang up'))
    if (session instanceof Error) vi.mocked(client.getSession).mockRejectedValueOnce(session)
    else vi.mocked(client.getSession).mockResolvedValueOnce(session as never)

    const error = await delivery().deliver({ sessionId: SESSION, content: 'hi' }).catch((caught: unknown) => caught)
    expect(deliveryFailure(error)).toEqual({ code: 'unknown', accepted: 'unknown' })
    expect((error as Error).message).toBe('socket hang up')
    expect(sessions().isActive(SESSION)).toBe(active)
  })

  it('reports an unreachable container as not sent, and marks nothing', async () => {
    runtime.ensureRunning.mockRejectedValueOnce(new Error('Docker is not running'))

    const error = await delivery().deliver({ sessionId: SESSION, content: 'hi' }).catch((caught: unknown) => caught)
    expect(deliveryFailure(error)).toEqual({ code: 'unavailable', accepted: false })
    expect(sessions().isActive(SESSION)).toBe(false)
  })

  it('stores a changed selection once the message went, and tells every window', async () => {
    settings.value = { llmDefault: { model: 'model-a', llmProviderId: 'conn-a' } }
    send().mockResolvedValueOnce({ selection: { model: 'model-b', llmProviderId: 'conn-a' } })
    const events = live.collect(SLUG, SESSION).events
    const write = vi.spyOn(service, 'updateSessionMetadata')

    await delivery().deliver({ sessionId: SESSION, content: 'hi', options: { model: 'model-b', effort: 'high' }, metadataUpdates: { alertDeviceId: null } })
    expect(write).toHaveBeenCalledOnce()
    expect(await metadata()).toMatchObject({ model: 'model-b', llmProviderId: 'conn-a', effort: 'high', alertDeviceId: null })
    expect(events).toContainEqual({ type: 'session_updated' })
    expect(live.host.sent('global')).toContainEqual({ type: 'session_updated', sessionId: SESSION, agentSlug: SLUG })
  })

  it('writes nothing when the send changed nothing', async () => {
    settings.value = { llmDefault: { model: 'model-a', llmProviderId: 'conn-a' } }
    send().mockResolvedValueOnce({ selection: { model: 'model-a', llmProviderId: 'conn-a' } })
    const write = vi.spyOn(service, 'updateSessionMetadata')

    await delivery().deliver({ sessionId: SESSION, content: 'hi', options: { model: 'model-a', llmProviderId: 'conn-a' } })
    expect(write).not.toHaveBeenCalled()
    expect(live.host.sent('global').filter((event) => event.type === 'session_updated')).toEqual([])
  })

  it('still reports a sent message as sent when storing its selection fails', async () => {
    settings.value = { llmDefault: { model: 'model-a', llmProviderId: 'conn-a' } }
    vi.spyOn(service, 'updateSessionMetadata').mockRejectedValueOnce(new Error('disk full'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await delivery().deliver({ sessionId: SESSION, content: 'hi', options: { effort: 'high' } }))
      .toEqual({ status: 'sent', queued: false })
    consoleError.mockRestore()
  })

  it('reads the session in its own turn, after the delivery ahead of it stored its selection', async () => {
    settings.value = { llmDefault: { model: 'model-a', llmProviderId: 'conn-a' } }
    let releaseFirst!: () => void
    send()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve({ selection: { model: 'model-b', llmProviderId: 'conn-a' } }) }))
      .mockResolvedValueOnce({})
    const read = vi.spyOn(service, 'getSessionMetadata')

    const first = delivery().deliver({ sessionId: SESSION, content: 'first', options: { model: 'model-b' } })
    await vi.waitFor(() => expect(send()).toHaveBeenCalledOnce())
    const second = delivery().deliver({ sessionId: SESSION, content: 'second' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const readsWhileFirstRuns = read.mock.calls.length
    releaseFirst()
    await Promise.all([first, second])

    expect(read.mock.calls.length).toBeGreaterThan(readsWhileFirstRuns)
    expect(send().mock.calls[1][3]).toMatchObject({ preserveRuntime: true })
    expect(send().mock.calls[1][3]?.sessionMetadata).toMatchObject({ model: 'model-b' })
  })

  it('promotes a hidden automation before the message goes', async () => {
    await sessionService.updateSessionMetadata(store(), SESSION, { isScheduledExecution: true })
    send().mockImplementation(async () => {
      expect(await metadata()).toMatchObject({ promotedToInteractive: true })
      return {}
    })

    await delivery().deliver({ sessionId: SESSION, content: 'I am here', promote: true })
    expect(send()).toHaveBeenCalledOnce()
  })
})

describe('start', () => {
  const request = {
    create: { initialMessage: 'go' },
    name: 'Scheduled run',
    metadata: { isScheduledExecution: true, automationStatus: 'running' as const },
  }

  beforeEach(() => {
    vi.mocked(client.createSession).mockResolvedValue({
      id: 'new-session', createdAt: '', lastActivity: '', workingDirectory: '/workspace',
      slashCommands: [{ name: 'deploy', description: 'Ship it', argumentHint: '' }],
    } as never)
  })

  it('creates, marks, registers with the listed commands, then attaches', async () => {
    const order: string[] = []
    const register = vi.spyOn(service, 'registerSession').mockImplementation(async (...args) => {
      order.push(`register (active ${sessions().isActive('new-session')})`)
      return sessionService.registerSession(...args)
    })
    vi.mocked(client.subscribeToStream).mockImplementationOnce((id) => {
      order.push(`attach ${id}`)
      return { unsubscribe: vi.fn(), ready: Promise.resolve() }
    })

    const session = await delivery().start(request)
    expect(session.id).toBe('new-session')
    expect(order).toEqual(['register (active true)', 'attach new-session'])
    expect(register).toHaveBeenCalledWith(store(), 'new-session', 'Scheduled run', {
      ...request.metadata,
      slashCommands: [{ name: 'deploy', description: 'Ship it', argumentHint: '' }],
    })
    expect(sessions().slashCommands('new-session')).toEqual([{ name: 'deploy', description: 'Ship it', argumentHint: '' }])
  })

  it('revokes the session when its registration fails', async () => {
    vi.spyOn(service, 'registerSession').mockRejectedValueOnce(new Error('disk full'))

    const error = await delivery().start(request).catch((caught: unknown) => caught)
    expect(startFailure(error)).toEqual({ code: 'register-failed', revoked: true })
    expect((error as Error).message).toBe('disk full')
    expect(client.deleteSession).toHaveBeenCalledWith('new-session')
    expect(sessions().isActive('new-session')).toBe(false)
    expect(client.subscribeToStream).not.toHaveBeenCalled()
  })

  it('revokes the session when its stream does not attach in time', async () => {
    vi.mocked(client.subscribeToStream).mockReturnValueOnce({ unsubscribe: vi.fn(), ready: new Promise(() => {}) })

    const error = await delivery().start({ ...request, attachTimeoutMs: 5 }).catch((caught: unknown) => caught)
    expect(startFailure(error)).toEqual({ code: 'attach-failed', revoked: true })
    expect(client.deleteSession).toHaveBeenCalledWith('new-session')
    expect(sessions().isSubscribed('new-session')).toBe(false)
    // Registered as a running automation: its run is over, or nothing would ever end it.
    expect((await sessionService.getSessionMetadata(store(), 'new-session'))?.automationStatus).toBe('failed')
  })

  it('revokes a session created after its deadline, before registering it', async () => {
    const register = vi.spyOn(service, 'registerSession')

    const error = await delivery().start({ ...request, notAfter: Date.now() - 1 }).catch((caught: unknown) => caught)
    expect(startFailure(error)).toEqual({ code: 'created-late', revoked: true })
    await vi.waitFor(() => expect(client.deleteSession).toHaveBeenCalledWith('new-session'))
    expect(register).not.toHaveBeenCalled()
  })

  it('answers at its deadline while create is still out, and revokes the session once it lands', async () => {
    let created!: (session: unknown) => void
    vi.mocked(client.createSession).mockReturnValueOnce(new Promise((resolve) => {
      created = resolve
    }) as never)
    const register = vi.spyOn(service, 'registerSession')

    const error = await delivery().start({ ...request, notAfter: Date.now() + 10 }).catch((caught: unknown) => caught)
    expect(startFailure(error)).toEqual({ code: 'created-late', revoked: true })
    expect(client.deleteSession).not.toHaveBeenCalled()

    created({ id: 'late-session', createdAt: '', lastActivity: '', workingDirectory: '/workspace' })
    await vi.waitFor(() => expect(client.deleteSession).toHaveBeenCalledWith('late-session'))
    expect(register).not.toHaveBeenCalled()
  })

  it('has nothing to revoke when create fails', async () => {
    vi.mocked(client.createSession).mockRejectedValueOnce(new MessageNotAcceptedError('rejected', 'Failed to create session'))

    const error = await delivery().start(request).catch((caught: unknown) => caught)
    expect(startFailure(error)).toEqual({ code: 'create-failed', revoked: false })
    expect((error as Error).cause).toBeInstanceOf(MessageNotAcceptedError)
    expect(client.deleteSession).not.toHaveBeenCalled()
  })
})

describe('attach', () => {
  it('is a no-op for an attached stream', async () => {
    await delivery().attach(SESSION)
    await delivery().attach(SESSION)
    expect(client.subscribeToStream).toHaveBeenCalledOnce()
  })
})

describe('stop', () => {
  beforeEach(async () => {
    await delivery().attach(SESSION)
    sessions().markActive(SESSION)
    vi.mocked(client.interruptSession).mockResolvedValue({ interrupted: true, processKept: false })
  })

  it('interrupts and marks the session stopped, denying reviews when asked', async () => {
    expect(await delivery().stop(SESSION, { scope: 'turn', denyReviews: true }))
      .toEqual({ path: 'interrupted', interrupted: true, processKept: false, escalated: false })
    expect(client.interruptSession).toHaveBeenCalledWith(SESSION, { scope: 'turn' })
    expect(sessions().isActive(SESSION)).toBe(false)
    expect(denyAllForAgent).toHaveBeenCalledWith(SLUG)
  })

  it('leaves an idle session alone when asked to stop only a running one', async () => {
    sessions().markInterrupted(SESSION)
    expect((await delivery().stop(SESSION, { scope: 'turn', ifActive: true })).path).toBe('skipped-idle')
    expect(client.interruptSession).not.toHaveBeenCalled()
  })

  it('marks the session stopped locally when the container is not running', async () => {
    running = false
    expect((await delivery().stop(SESSION, { scope: 'turn' })).path).toBe('not-running')
    expect(client.interruptSession).not.toHaveBeenCalled()
    expect(sessions().isActive(SESSION)).toBe(false)
  })

  it('marks the session stopped when the interrupt throws', async () => {
    vi.mocked(client.interruptSession).mockRejectedValueOnce(new Error('container exploded'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await delivery().stop(SESSION, { scope: 'turn' })).path).toBe('interrupt-failed')
    expect(sessions().isActive(SESSION)).toBe(false)
    consoleError.mockRestore()
  })

  it('leaves a turn running when asked to mark only a confirmed interrupt and none came', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(client.interruptSession).mockRejectedValueOnce(new Error('container exploded'))
    expect((await delivery().stop(SESSION, { scope: 'turn', onlyIfConfirmed: true })).path).toBe('interrupt-failed')
    expect(sessions().isActive(SESSION)).toBe(true)

    vi.mocked(client.interruptSession).mockResolvedValueOnce({ interrupted: false, processKept: false })
    expect(await delivery().stop(SESSION, { scope: 'turn', onlyIfConfirmed: true })).toMatchObject({ path: 'interrupted', interrupted: false })
    expect(sessions().isActive(SESSION)).toBe(true)

    expect(await delivery().stop(SESSION, { scope: 'turn', onlyIfConfirmed: true })).toMatchObject({ path: 'interrupted', interrupted: true })
    expect(sessions().isActive(SESSION)).toBe(false)
    consoleError.mockRestore()
  })

  it('stops everything when only untracked background work would be left', async () => {
    vi.spyOn(sessions(), 'hasOnlyUntrackedBackgroundWork').mockReturnValue(true)
    expect(await delivery().stop(SESSION, { scope: 'turn', escalateUntracked: true })).toMatchObject({ escalated: true })
    expect(client.interruptSession).toHaveBeenCalledWith(SESSION, { scope: 'all' })
  })

  it('reads the turn generation just before the interrupt, for the mark to tell the stopped turn from a later one', async () => {
    vi.spyOn(sessions(), 'turnGeneration').mockReturnValue(7)
    vi.mocked(client.interruptSession).mockResolvedValueOnce({ interrupted: true, processKept: true })
    const mark = vi.spyOn(sessions(), 'markInterrupted')
    await delivery().stop(SESSION, { scope: 'turn' })
    expect(mark).toHaveBeenCalledWith(SESSION, { processKept: true, turnGenerationBefore: 7 })
  })
})
