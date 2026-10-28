/**
 * The in-memory state one agent owns: its live sessions, its pending
 * user-input requests, the reviews and re-auth waits parked on them, its
 * computer-use grants, and what the host's per-agent work keeps between
 * requests (locks, widget refreshes, the MCP proxy's sessions, volume
 * uploads, sessions waiting for a human to name them).
 *
 * Created with the agent's actor and released with it, so `agentRegistry.evict`
 * is the one operation that ends everything an agent held in this process.
 * The stores know nothing of other agents; the process-wide routers
 * (`userInputRequestManager` and friends) reach them through the directory
 * the registry attaches.
 */
import { AgentInputRequests } from '@shared/lib/tools/requests/agent-input-requests'
import { AgentReviews } from '@shared/lib/proxy/agent-reviews'
import {
  createAccountReauthWaits,
  createMcpReauthWaits,
  type AccountReauthWaits,
  type McpReauthWaits,
} from '@shared/lib/proxy/reauth-waits'
import { AgentComputerUse } from '@shared/lib/computer-use/agent-permissions'
import { AgentWidgetRefreshes } from '@shared/lib/widgets/agent-widget-refreshes'
import { AgentMcpSessions } from '@shared/lib/mcp/agent-mcp-sessions'
import { VolumeUploadGuard } from '@shared/lib/volumes/volume-upload-guard'
import { AgentLocks } from './agent-locks'
import { LiveSessions, type LiveSessionsDeps } from './live/live-sessions'
import type { SessionEvent } from './live/session-channel'
import type { HostRunActor } from './host-runs'
import type { SessionStore } from './session-store'
import type { AgentSlug } from './types'

export interface AgentState {
  /**
   * Where the agent's sessions are. It goes with the state: what the live
   * sessions record must land where the actor's reads look, also for a
   * handle that adopts state an earlier one built (a dev-server reload).
   */
  readonly store: SessionStore
  readonly sessions: LiveSessions
  readonly inputRequests: AgentInputRequests
  readonly reviews: AgentReviews
  readonly accountReauth: AccountReauthWaits
  readonly mcpReauth: McpReauthWaits
  readonly computerUse: AgentComputerUse
  /** The agent's own parts, as an approved computer-use or script run needs them. */
  readonly hostRuns: HostRunActor
  readonly locks: AgentLocks
  readonly widgetRefreshes: AgentWidgetRefreshes
  readonly mcpSessions: AgentMcpSessions
  readonly volumeUploads: VolumeUploadGuard
  /** Sessions opened by a notice, to be named from the first message a person sends. */
  readonly deferredNaming: Set<string>
}

export interface AgentStateHooks {
  /** What the agent's live sessions reach outside the agent. */
  sessions: Pick<LiveSessionsDeps, 'store' | 'host' | 'runtime' | 'capture'>
}

export function createAgentState(slug: AgentSlug, hooks: AgentStateHooks): AgentState {
  // A request transition is put on the wire by the agent's sessions. The
  // sessions are built from the stores, so the sink reaches them through
  // this binding, set before any request can exist.
  let sessions: LiveSessions | undefined
  const inputRequests = new AgentInputRequests(slug, {
    report: (transition) => sessions?.requestTransition(transition),
  })
  const computerUse = new AgentComputerUse(slug)
  // One view of the agent for every host run: the decision routes' (through
  // the actor) and the auto-approved ones the sessions start. Settling a run
  // goes through the sessions, so it reaches the session's wire.
  const hostRuns: HostRunActor = {
    inputs: {
      claim: async (id, options) => inputRequests.claimRequest(id, options?.leaseMs),
      releaseClaim: async (id, token) => inputRequests.releaseClaim(id, token),
      resolve: async (id, outcome) => inputRequests.resolve(id, outcome),
      complete: async (sessionId, id, outcome) => sessions?.completeRequest(sessionId, id, outcome),
      computerUse: {
        grant: async (...args) => computerUse.grant(...args),
        consumeOnce: async (...args) => computerUse.consumeOnce(...args),
        setGrabbedApp: async (appName) => computerUse.setGrabbed(appName),
        clearGrabbedApp: async () => computerUse.clearGrabbed(),
        clearPending: async (sessionId, id, outcome = 'answered') => sessions?.clearComputerUseRequest(sessionId, id, outcome),
      },
    },
    container: { fetch: (path, init) => hooks.sessions.runtime.client().fetch(path, init) },
    messages: { broadcastEvent: async (sessionId, event) => sessions?.emit(sessionId, event as SessionEvent) },
  }
  sessions = new LiveSessions({ slug, requests: inputRequests, computerUse, runs: hostRuns, ...hooks.sessions })
  // A review or re-auth wait opening or closing changes whether the agent's sessions wait.
  const live = sessions
  const syncAwaiting = () => live.syncAwaiting()
  // A proxied call's session is a claim from the agent's own container, used
  // only to place the card: scoped to that session while it runs, otherwise
  // (no claim, an ended or unknown session) to the whole agent.
  const cardSession = (callerSessionId: string | undefined) =>
    callerSessionId && live.isActive(callerSessionId) ? callerSessionId : undefined
  return {
    store: hooks.sessions.store,
    sessions: live,
    inputRequests,
    reviews: new AgentReviews(slug, inputRequests, syncAwaiting, cardSession),
    accountReauth: createAccountReauthWaits(slug, inputRequests, syncAwaiting, cardSession),
    mcpReauth: createMcpReauthWaits(slug, inputRequests, syncAwaiting, cardSession),
    computerUse,
    hostRuns,
    locks: new AgentLocks(),
    widgetRefreshes: new AgentWidgetRefreshes(),
    mcpSessions: new AgentMcpSessions(),
    volumeUploads: new VolumeUploadGuard(),
    deferredNaming: new Set(),
  }
}

/**
 * The session is gone: settle the calls parked on its own review and re-auth
 * cards before its live state drops those cards with it.
 */
export function releaseSessionState(state: AgentState, sessionId: string): void {
  state.reviews.dropSession(sessionId)
  state.accountReauth.dropSession(sessionId)
  state.mcpReauth.dropSession(sessionId)
}

/**
 * The user stopped the session: dismiss the calls parked on its own re-auth
 * cards, as the stop denies its reviews.
 */
export function settleStoppedSession(state: AgentState, sessionId: string): void {
  state.accountReauth.dropSession(sessionId, 'The session was stopped.')
  state.mcpReauth.dropSession(sessionId, 'The session was stopped.')
}

/**
 * The agent is gone from this process: reject every parked call, settle
 * every open request so its listeners hear the end of it, then drop the
 * sessions' streams and timers. The requests go first, so their resolved
 * events still reach the sessions' listeners. Waiters on a lock are turned
 * away and joiners of a widget refresh hear it will not end here; the rest
 * of the host's per-agent memory is dropped with the state. The persisted
 * computer-use grants are left where they are; they belong to the agent's
 * settings entry, not to the process.
 */
export function releaseAgentState(state: AgentState): void {
  const gone = (what: string) => `${what} dropped: the agent is no longer held by this process`
  state.reviews.rejectAll()
  state.accountReauth.rejectAll(gone('Account re-authentication'))
  state.mcpReauth.rejectAll(gone('MCP re-authentication'))
  state.inputRequests.dispose()
  state.computerUse.clearGrabbed()
  state.sessions.dispose()
  state.locks.dispose()
  state.widgetRefreshes.dispose()
  state.mcpSessions.clear()
  state.deferredNaming.clear()
}
