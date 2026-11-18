/**
 * Test helper: the actors' stores without the actors.
 *
 * In the app the agent registry creates each agent's `AgentState` with its
 * handle and attaches a directory over the handles to the process-wide
 * routers (`userInputRequestManager`, `reviewManager`, ...). A test that
 * drives a router or a route without the real registry has no handles, so
 * nothing would attach: this builds the same states in a map and attaches
 * them to the singletons, the way the registry would.
 *
 *   const agents = attachInMemoryAgentState()
 *   userInputRequestManager.register({ scope: { agentSlug: 'a', ... }, ... })
 *   agents.get('a').inputRequests.getOpenRequests()  // it is there
 *   agents.reset()                                    // between tests
 *
 * Each state's live sessions are real, over an in-memory session store, a
 * recording host port and a runtime with no container; `sessions` replaces
 * any of those for a slug.
 */
import { accountReauthManager } from '@shared/lib/proxy/account-reauth-manager'
import { mcpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'
import { createAgentState, releaseAgentState, type AgentState, type AgentStateHooks } from '../agent-state'
import type { SessionsRuntime } from '../live/live-sessions'
import type { AgentStoreDirectory } from '../store-directory'
import type { AgentSlug } from '../types'
import { createInMemorySessionStore } from './in-memory-session-store'
import { createRecordingHostPort } from './recording-host-port'

export interface InMemoryAgentStateOptions {
  /** What a slug's live sessions reach, in place of the in-memory defaults. */
  sessions?: (slug: AgentSlug) => Partial<AgentStateHooks['sessions']>
}

/** A runtime with no container: there is no client, and nothing recovers. */
export const NO_CONTAINER_RUNTIME: SessionsRuntime = {
  client: () => {
    throw new Error('No container in this test')
  },
  fatalResult: () => 'settle',
  unexpectedDeath: () => {},
  stopAfterFatalError: () => {},
}

export interface InMemoryAgentStateDirectory extends AgentStoreDirectory<AgentState> {
  /** The states built so far, by slug. */
  readonly states: Map<AgentSlug, AgentState>
  /** A directory over one store of every state, as the registry attaches to a router. */
  pick<T>(select: (state: AgentState) => T): AgentStoreDirectory<T>
  /** Release every state (rejecting what is parked) and forget it. */
  reset(): void
  /** Detach the singletons again. */
  detach(): void
}

export function createInMemoryAgentState(options: InMemoryAgentStateOptions = {}): InMemoryAgentStateDirectory {
  const states = new Map<AgentSlug, AgentState>()
  const get = (slug: AgentSlug): AgentState => {
    let state = states.get(slug)
    if (!state) {
      state = createAgentState(slug, {
        sessions: {
          store: createInMemorySessionStore(slug),
          host: createRecordingHostPort().port,
          runtime: NO_CONTAINER_RUNTIME,
          ...options.sessions?.(slug),
        },
      })
      states.set(slug, state)
    }
    return state
  }
  const pick = <T>(select: (state: AgentState) => T): AgentStoreDirectory<T> => ({
    get: (slug) => select(get(slug)),
    peek: (slug) => {
      const state = states.get(slug)
      return state ? select(state) : undefined
    },
    all: () => [...states.values()].map(select),
  })
  return {
    states,
    get,
    peek: (slug) => states.get(slug),
    all: () => [...states.values()],
    pick,
    reset: () => {
      for (const state of states.values()) releaseAgentState(state)
      states.clear()
      userInputRequestManager.reset()
    },
    detach: () => {
      userInputRequestManager.attachAgents?.(null)
      reviewManager.attachAgents?.(null)
      accountReauthManager.attachAgents?.(null)
      mcpReauthManager.attachAgents?.(null)
      computerUsePermissionManager.attachAgents?.(null)
    },
  }
}

/**
 * Build an in-memory directory and attach it to every router singleton. A
 * router the test has replaced with a double may not carry the port; the
 * real ones do.
 */
export function attachInMemoryAgentState(options: InMemoryAgentStateOptions = {}): InMemoryAgentStateDirectory {
  const agents = createInMemoryAgentState(options)
  userInputRequestManager.attachAgents?.(agents.pick((state) => state.inputRequests))
  reviewManager.attachAgents?.(agents.pick((state) => state.reviews))
  accountReauthManager.attachAgents?.(agents.pick((state) => state.accountReauth))
  mcpReauthManager.attachAgents?.(agents.pick((state) => state.mcpReauth))
  computerUsePermissionManager.attachAgents?.(agents.pick((state) => state.computerUse))
  return agents
}
