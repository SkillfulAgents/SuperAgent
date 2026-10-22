/**
 * Test helper: agents' live sessions over test doubles, for a test that
 * drives a session's container stream frame by frame.
 *
 *   const live = attachLiveSessionsHarness()
 *   const client = createStreamClient()
 *   await live.sessions('agent').subscribe('s1', client, 's1')
 *   const events = live.collect('agent', 's1')
 *   client.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
 *   live.reset()  // between tests
 *
 * The sessions are real (`LiveSessions` on an in-memory `AgentState`,
 * attached to the routers as the registry would). What they reach outside
 * the agent is a double:
 * - the session store: an in-memory one per slug (`store(slug)`);
 * - the host: a recording port (`host`); calls it has no answer for, and
 *   every send, go on to `host.fallback` when one is given;
 * - the container runtime: `runtime.client()` answers with `containerFetch`
 *   for the input resolutions the sessions post; the death and fatal hooks
 *   are mocks.
 */
import { vi } from 'vitest'
import type { ContainerClient, StreamMessage } from '@shared/lib/container/types'
import type { HostPort } from '../host-port'
import type { LiveSessions, SessionsRuntime } from '../live/live-sessions'
import type { AgentSlug } from '../types'
import { attachInMemoryAgentState, type InMemoryAgentStateDirectory } from './in-memory-agent-state'
import { createInMemorySessionStore } from './in-memory-session-store'
import { createRecordingHostPort, type HostCallAnswers, type RecordingHostPort } from './recording-host-port'

/** A container client whose stream the test feeds with `emit`. */
export type StreamClient = ContainerClient & {
  /** Deliver one frame on the stream the sessions subscribed to. */
  emit(content: unknown): void
  /** The session id of the last stream subscribed, if any. */
  readonly subscribedSessionId: string | null
}

export function createStreamClient(): StreamClient {
  let callback: ((message: StreamMessage) => void) | null = null
  let subscribedSessionId: string | null = null
  const client = {
    emit(content: unknown) {
      callback?.({ type: 'message', content, timestamp: new Date(), sessionId: subscribedSessionId ?? 'test-session' })
    },
    get subscribedSessionId() {
      return subscribedSessionId
    },
    start: vi.fn(),
    stop: vi.fn(),
    stopSync: vi.fn(),
    getInfoFromRuntime: vi.fn(),
    getInfo: vi.fn(),
    fetch: vi.fn(async () => new Response('{}')),
    waitForHealthy: vi.fn(),
    isHealthy: vi.fn(),
    getStats: vi.fn(),
    createSession: vi.fn(),
    getSession: vi.fn(async () => null),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    interruptSession: vi.fn(),
    subscribeToStream: vi.fn((sessionId: string, onMessage: (message: StreamMessage) => void) => {
      subscribedSessionId = sessionId
      callback = onMessage
      return { unsubscribe: vi.fn(), ready: Promise.resolve() }
    }),
    on: vi.fn(),
    off: vi.fn(),
    onFatalResult: vi.fn(() => 'settle'),
    observeUnexpectedDeath: vi.fn(async () => ({ action: 'settle' })),
    getRuntimeGenerationId: vi.fn(() => null),
  }
  return client as unknown as StreamClient
}

export interface LiveSessionsHarness {
  readonly agents: InMemoryAgentStateDirectory
  /** The agent's live sessions (created with its state on first use). */
  sessions(slug: AgentSlug): LiveSessions
  /** The agent's in-memory session store. */
  store(slug: AgentSlug): ReturnType<typeof createInMemorySessionStore>
  readonly host: RecordingHostPort
  readonly runtime: SessionsRuntime & {
    /** What `runtime.client().fetch` answers: the container's input endpoints. */
    containerFetch: ReturnType<typeof vi.fn<ContainerClient['fetch']>>
    fatalResult: ReturnType<typeof vi.fn<SessionsRuntime['fatalResult']>>
    unexpectedDeath: ReturnType<typeof vi.fn<SessionsRuntime['unexpectedDeath']>>
    stopAfterFatalError: ReturnType<typeof vi.fn<SessionsRuntime['stopAfterFatalError']>>
  }
  /** Listen to a session's events; returns them as they arrive, and the unsubscribe. */
  collect(slug: AgentSlug, sessionId: string): { events: Array<Record<string, unknown>>; stop: () => void }
  /** Release every agent's state, forget the stores, and put every double back as it was created. */
  reset(): void
}

export function attachLiveSessionsHarness(
  options: { answers?: HostCallAnswers; fallback?: HostPort } = {},
): LiveSessionsHarness {
  const stores = new Map<AgentSlug, ReturnType<typeof createInMemorySessionStore>>()
  const store = (slug: AgentSlug) => {
    let found = stores.get(slug)
    if (!found) {
      found = createInMemorySessionStore(slug)
      stores.set(slug, found)
    }
    return found
  }
  const host = createRecordingHostPort(options.answers, options.fallback)
  const answerFetch: ContainerClient['fetch'] = async () => new Response('{}')
  const deferToClient: SessionsRuntime['fatalResult'] = (client, kind) => client?.onFatalResult(kind) ?? 'settle'
  const containerFetch = vi.fn<ContainerClient['fetch']>(answerFetch)
  const runtime = {
    containerFetch,
    client: () => ({ fetch: containerFetch }) as unknown as ContainerClient,
    fatalResult: vi.fn<SessionsRuntime['fatalResult']>(deferToClient),
    unexpectedDeath: vi.fn<SessionsRuntime['unexpectedDeath']>(),
    stopAfterFatalError: vi.fn<SessionsRuntime['stopAfterFatalError']>(),
  }
  const agents = attachInMemoryAgentState({
    sessions: (slug) => ({ store: store(slug), host: host.port, runtime }),
  })
  return {
    agents,
    sessions: (slug) => agents.get(slug).sessions,
    store,
    host,
    runtime,
    collect: (slug, sessionId) => {
      const events: Array<Record<string, unknown>> = []
      const stop = agents.get(slug).sessions.listen(sessionId, (event) => events.push(event as Record<string, unknown>))
      return { events, stop }
    },
    reset: () => {
      agents.reset()
      stores.clear()
      host.reset()
      containerFetch.mockReset().mockImplementation(answerFetch)
      runtime.fatalResult.mockReset().mockImplementation(deferToClient)
      runtime.unexpectedDeath.mockReset()
      runtime.stopAfterFatalError.mockReset()
    },
  }
}
