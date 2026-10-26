/**
 * What the container's `capabilities` handshake tells a session's state that
 * the host lost: a host that restarted (a Durable Object reset on deploy)
 * attaches with no live state while the container is mid-turn, maybe parked
 * on the user. The sessions are real (`attachLiveSessionsHarness`), fed frame
 * by frame through a stream client.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => ({}),
}))

import { attachLiveSessionsHarness, createStreamClient, type StreamClient } from '../testing/live-sessions-harness'

const SESSION_ID = 'restarted-session'
const AGENT_SLUG = 'test-agent'

const live = attachLiveSessionsHarness()
const sessions = () => live.sessions(AGENT_SLUG)
const requests = () => live.agents.get(AGENT_SLUG).inputRequests

let client: StreamClient
let events: Array<Record<string, unknown>>
let stopCollecting: () => void

const handshake = (fields: Record<string, unknown>) =>
  client.emit({ type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-1', ...fields })

/** The container's answer to `GET /inputs/pending`. */
function parkedInContainer(parked: Array<{ toolUseId: string; inputType: string; sessionId?: string }>) {
  live.runtime.containerFetch.mockImplementation(async (path) =>
    path === '/inputs/pending' ? Response.json(parked) : new Response('{}'),
  )
}

const pendingFetches = () => live.runtime.containerFetch.mock.calls.filter(([path]) => path === '/inputs/pending')

beforeEach(async () => {
  client = createStreamClient()
  await sessions().subscribe(SESSION_ID, client, SESSION_ID)
  const collected = live.collect(AGENT_SLUG, SESSION_ID)
  events = collected.events
  stopCollecting = collected.stop
})

afterEach(() => {
  stopCollecting()
  sessions().unsubscribe(SESSION_ID)
  live.reset()
  vi.clearAllMocks()
})

describe('the capabilities handshake, for a host that lost its live state', () => {
  it('a turn running in the container makes the session active, as a send would have', () => {
    expect(sessions().isActive(SESSION_ID)).toBe(false)

    handshake({ turn_in_flight: true })

    expect(sessions().isActive(SESSION_ID)).toBe(true)
    expect(events.filter((e) => e.type === 'session_active')).toHaveLength(1)
  })

  it('a handshake that says no turn runs changes nothing', () => {
    handshake({ turn_in_flight: false })
    expect(sessions().isActive(SESSION_ID)).toBe(false)

    // A send marks the session before the container's turn starts.
    sessions().markActive(SESSION_ID)
    handshake({ turn_in_flight: false })
    expect(sessions().isActive(SESSION_ID)).toBe(true)
    expect(pendingFetches()).toHaveLength(0)
  })

  it('a handshake from an older container (no turn_in_flight) changes nothing', () => {
    handshake({})
    expect(sessions().isActive(SESSION_ID)).toBe(false)
    expect(pendingFetches()).toHaveLength(0)
  })

  it('the background tasks it lists are tracked again, without marking the session waiting on them', () => {
    handshake({
      turn_in_flight: false,
      background_tasks: { tasks: [{ task_id: 'bg-1', task_type: 'local_bash', description: 'Build' }] },
    })

    expect(sessions().backgroundTasks(SESSION_ID).map((task) => task.taskId)).toEqual(['bg-1'])
    expect(sessions().isActive(SESSION_ID)).toBe(false)
  })

  it('the asks the container is parked on for this session are registered again', async () => {
    parkedInContainer([
      { toolUseId: 'ask-mine', inputType: 'question', sessionId: SESSION_ID },
      { toolUseId: 'ask-other-session', inputType: 'question', sessionId: 'another-session' },
      { toolUseId: 'host-answered', inputType: 'schedule_task', sessionId: SESSION_ID },
      { toolUseId: 'keeps-own-wait', inputType: 'computer_use', sessionId: SESSION_ID },
    ])

    handshake({ turn_in_flight: true })

    await vi.waitFor(() => expect(requests().getOpenRequest('ask-mine')).toBeTruthy())
    expect(requests().getOpenRequest('ask-mine')).toMatchObject({
      kind: 'question',
      scope: { sessionId: SESSION_ID },
      payload: { recovered: true },
    })
    expect(requests().getOpenRequest('ask-other-session')).toBeFalsy()
    expect(requests().getOpenRequest('host-answered')).toBeFalsy()
    expect(requests().getOpenRequest('keeps-own-wait')).toBeFalsy()
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
  })

  it('an ask the host still has open is not registered a second time', async () => {
    sessions().markActive(SESSION_ID)
    requests().register({
      id: 'ask-open',
      kind: 'question',
      scope: { agentSlug: AGENT_SLUG, sessionId: SESSION_ID },
      blocking: true,
      payload: { questions: [] },
    })
    parkedInContainer([{ toolUseId: 'ask-open', inputType: 'question', sessionId: SESSION_ID }])

    handshake({ turn_in_flight: true })

    await vi.waitFor(() => expect(pendingFetches()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests().getOpenRequest('ask-open')?.payload).toEqual({ questions: [] })
  })

  it('a container that cannot list its parked asks leaves the session active and does not throw', async () => {
    live.runtime.containerFetch.mockImplementation(async () => new Response('unavailable', { status: 503 }))

    handshake({ turn_in_flight: true })

    await vi.waitFor(() => expect(pendingFetches()).toHaveLength(1))
    expect(sessions().isActive(SESSION_ID)).toBe(true)
  })
})
