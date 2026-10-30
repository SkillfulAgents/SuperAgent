import type { containerHost } from '@shared/lib/container/container-host'
import type { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'
import type { reviewManager } from '@shared/lib/proxy/review-manager'
import type { accountReauthManager } from '@shared/lib/proxy/account-reauth-manager'
import type { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import type { mcpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import type * as sessionService from '@shared/lib/services/session-service'
import type { appendAssistantEntry, appendInformationalEntry } from '@shared/lib/services/session-transcript-append'
import type { recordSessionActivity } from '@shared/lib/services/session-summary-cache'
import type * as transcriptOps from './local-transcript-ops'
import type { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import type { syncAgentConnectionEnvironment } from '@shared/lib/container/connection-runtime-sync'
import type { loadDailyUsageData, loadSessionUsageTotals } from '@shared/lib/services/usage-service'
import type { HostPort } from './host-port'
import { runComputerUse, runScript } from './host-runs'
import type { LiveSessions, SessionsRuntime } from './live/live-sessions'
import type { SessionEvent } from './live/session-channel'
import { SubagentCapture } from '@shared/lib/container/subagent-capture'
import { background } from '@shared/lib/background'
import { createMemoryOps } from './memory-ops'
import { matchesTranscriptQuery } from './transcript-query'
import { createSessionDelivery, notAcceptedError, type SessionDelivery } from './delivery'
import { MessageNotAcceptedError } from '@shared/lib/container/message-dispatch-error'
import { createAgentState, releaseAgentState, type AgentState } from './agent-state'
import { createLocalSessionStore } from './local-session-store'
import { transcriptPath, type SessionStore } from './session-store'
import { sessionEvents, sessionFrames } from './session-streams'
import type { UserInputRequestOutcome } from '@shared/lib/tools/requests/request-schema'
import type {
  AccountReauthOps,
  AgentActor,
  AgentLiveSummary,
  AgentSlug,
  ComputerUseOps,
  ConfigOps,
  ContainerOps,
  FileOps,
  InputOps,
  LockOps,
  McpReauthOps,
  McpSessionOps,
  MessageOps,
  MemoryOps,
  ReviewOps,
  SessionOps,
  UsageOps,
  VolumeUploadOps,
  WidgetOps,
} from './types'

/**
 * What a local actor delegates to. Injected so the registry can be built
 * against fakes in tests.
 *
 * Every op reads its dependency from `deps` at call time, never at
 * construction, so a dependency is only touched by the call that uses it.
 * The container host hands out this agent's `ContainerRuntime`, which holds
 * the client and every cached fact about the container.
 *
 * The user-input, review, re-auth and computer-use managers are routers over
 * state the actors own: the registry hands them the way to every actor's stores.
 */
export interface LocalActorDeps {
  readonly containerHost: typeof containerHost
  readonly userInputRequestManager: typeof userInputRequestManager
  readonly reviewManager: typeof reviewManager
  readonly accountReauthManager: typeof accountReauthManager
  readonly computerUsePermissionManager: typeof computerUsePermissionManager
  readonly mcpReauthManager: typeof mcpReauthManager
  readonly sessionService: typeof sessionService
  readonly transcripts: typeof transcriptOps
  readonly appendInformationalEntry: typeof appendInformationalEntry
  readonly appendAssistantEntry: typeof appendAssistantEntry
  readonly recordSessionActivity: typeof recordSessionActivity
  readonly getAgentWorkspaceDir: typeof getAgentWorkspaceDir
  readonly syncAgentConnectionEnvironment: typeof syncAgentConnectionEnvironment
  readonly loadDailyUsageData: typeof loadDailyUsageData
  readonly loadSessionUsageTotals: typeof loadSessionUsageTotals
  /** The host this agent asks for host tools, machine work and side effects. */
  readonly host: HostPort
}

// Dev-only capture of the sessions' frames for fixture replays: one per
// process, so offsets and snapshot numbers compare across agents.
const subagentCapture = SubagentCapture.fromEnv()

/**
 * An agent whose container and files are managed by this process.
 *
 * Runtime methods delegate with the agent's store or slug, or with the
 * actor's own stores where the state is the actor's. Storage capabilities
 * such as memories compose operations over this actor's files. The ops are
 * closures rather than class methods so a caller may destructure them
 * (`const { send } = actor.messages`).
 */
export class LocalAgentActor implements AgentActor {
  readonly live: () => Promise<AgentLiveSummary>
  readonly container: ContainerOps
  readonly sessions: SessionOps
  readonly messages: MessageOps
  readonly inputs: InputOps
  readonly usage: UsageOps
  readonly files: FileOps
  readonly memories: MemoryOps
  readonly config: ConfigOps
  readonly locks: LockOps
  readonly widgets: WidgetOps
  readonly mcpSessions: McpSessionOps
  readonly volumeUploads: VolumeUploadOps
  /** Where this agent's sessions are: the files, the config documents, the transcripts directory. */
  readonly store: SessionStore
  /**
   * What this agent holds in memory: its live sessions, its pending
   * user-input requests, the reviews and re-auth waits parked on them, its
   * computer-use grants. Created with the handle and released by `dispose`.
   */
  readonly state: AgentState

  /**
   * `state` is given when the handle is wrapping state that outlived an
   * earlier handle for the slug (the registry rebuilding after a dev-server
   * reload); otherwise the handle starts with none.
   */
  constructor(readonly slug: AgentSlug, deps: LocalActorDeps, state?: AgentState) {
    // Every write to a session goes through the store, so this is where the
    // container's idle clock learns of session activity — the live sessions'
    // stream frames, the transcript appends and `sessions.recordActivity`
    // all record through it.
    this.state =
      state ??
      createAgentState(slug, {
        sessions: {
          store: createLocalSessionStore(slug, deps, {
            onActivity: (at) => deps.containerHost.runtime(slug).noteSessionActivity(at),
          }),
          host: deps.host,
          runtime: createSessionsRuntime(slug, deps),
          capture: subagentCapture,
        },
      })
    this.store = this.state.store
    this.files = this.store.files
    this.memories = createMemoryOps(this.store.files)
    this.config = this.store.config
    this.live = async () => liveSummary(slug, this.state, deps)
    this.container = createContainerOps(slug, deps)
    const delivery = createSessionDelivery(slug, this.store, this.state.sessions, deps)
    this.sessions = createSessionOps(slug, this.store, this.state, delivery, deps)
    this.messages = createMessageOps(slug, this.store, this.state.sessions, delivery, deps)
    this.inputs = createInputOps(slug, this.state, deps)
    this.usage = createUsageOps(this.store, deps)
    this.locks = createLockOps(this.state)
    this.widgets = createWidgetOps(this.state)
    this.mcpSessions = createMcpSessionOps(this.state)
    this.volumeUploads = createVolumeUploadOps(this.state)
  }

  /** The registry is dropping this handle: release everything it owns. */
  dispose(): void {
    releaseAgentState(this.state)
  }
}

function liveSummary(slug: AgentSlug, state: AgentState, deps: LocalActorDeps): AgentLiveSummary {
  const runtime = deps.containerHost.runtime(slug)
  return {
    container: {
      ...runtime.getCachedInfo(),
      healthWarnings: runtime.getHealthWarnings(),
      stale: runtime.isStale(),
      idleSince: runtime.idleSince(),
    },
    activeSessionIds: state.sessions.activeIds(),
    awaitingSessionIds: state.sessions.awaitingIds(),
    openRequests: state.inputRequests.getOpenRequests().map(({ id, kind, blocking, autoApproved, scope }) => ({
      id, kind, blocking, autoApproved, ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
    })),
    pendingReviews: deps.reviewManager.getPendingReviewsForAgent(slug).map(({ id, displayText }) => ({ id, displayText })),
  }
}

function createContainerOps(slug: AgentSlug, deps: LocalActorDeps): ContainerOps {
  const runtime = () => deps.containerHost.runtime(slug)
  const client = () => runtime().getClient()
  return {
    start: async () => {
      await runtime().ensureRunning()
    },
    stop: (...args) => runtime().stopContainer(...args),
    keepAlive: async () => runtime().keepAlive(),
    status: async () => runtime().getCachedInfo(),
    invalidate: async (options) => {
      if (runtime().getCachedInfo().status !== 'running') return 'not-running'
      if (!options?.restart) {
        runtime().markStale()
        return 'marked-stale'
      }
      await runtime().restartContainer()
      return 'restarted'
    },
    info: () => client().getInfo(),
    syncConnectionEnvironment: (kind, options) => deps.syncAgentConnectionEnvironment(slug, kind, runtime(), options),
    fetch: (...args) => client().fetch(...args),
    webSocketTarget: async (path, init) => {
      const info = runtime().getCachedInfo()
      if (info.status !== 'running' || !info.port) return null
      const c = client()
      return {
        url: `${c.getWebSocketBaseUrl(info.port)}${path}${init?.search ?? ''}`,
        ...(init?.protocols !== undefined ? { protocols: init.protocols } : {}),
        headers: { ...init?.headers, ...c.getHostAuthHeaders() },
      }
    },
    hostBridgeIp: async () => client().getHostBridgeIp(),
    probeHostPort: (host, port) => client().probeHostPortFromRunner(host, port),
  }
}

function createSessionOps(
  slug: AgentSlug,
  store: SessionStore,
  state: AgentState,
  delivery: SessionDelivery,
  deps: LocalActorDeps,
): SessionOps {
  const client = () => deps.containerHost.runtime(slug).getClient()
  const live = state.sessions
  return {
    list: (...args) => deps.sessionService.listSessions(store, ...args),
    listFromSummary: (...args) => deps.sessionService.listSessionsFromSummary(store, ...args),
    listByIds: (...args) => deps.sessionService.listSessionsByIds(store, ...args),
    get: (...args) => deps.sessionService.getSession(store, ...args),
    summary: () => deps.sessionService.getSessionSummary(store),
    exists: (sessionId) => deps.sessionService.sessionExists(store, sessionId),
    isKnown: (sessionId) => deps.sessionService.sessionIsKnown(store, sessionId),
    isRegistered: (sessionId) => deps.sessionService.isSessionRegistered(store, sessionId),
    register: (...args) => deps.sessionService.registerSession(store, ...args),
    rename: async (sessionId, name) => {
      await deps.sessionService.updateSessionName(store, sessionId, name)
      live.emit(sessionId, { type: 'session_updated' })
      deps.host.send('global', { type: 'session_updated', sessionId, agentSlug: slug })
    },
    // The stream lets go first, so an append in flight cannot write the transcript again after it is gone.
    delete: (sessionId) => {
      live.unsubscribe(sessionId)
      state.deferredNaming.delete(sessionId)
      return deps.sessionService.deleteSession(store, sessionId)
    },
    // Decided and let go of in one step, before the delete, as `delete` does.
    deleteMany: async (sessionIds) => {
      const idle = sessionIds.filter((sessionId) => !live.isActive(sessionId))
      for (const sessionId of idle) {
        live.unsubscribe(sessionId)
        state.deferredNaming.delete(sessionId)
      }
      return deps.sessionService.deleteSessionsBatch(store, idle)
    },
    metadata: (sessionId) => deps.sessionService.getSessionMetadata(store, sessionId),
    readMetadata: () => deps.sessionService.readSessionMetadata(store),
    updateMetadata: (sessionId, updates) => deps.sessionService.updateSessionMetadata(store, sessionId, updates),
    fileRealPathWithinAgent: (sessionId) => deps.sessionService.sessionFileRealPathWithinAgent(store, sessionId),
    usage: (sessionId) =>
      deps.loadSessionUsageTotals({ files: store.files, transcript: transcriptPath(store, sessionId) }),
    byScheduledTask: (taskId) => deps.sessionService.getSessionsByScheduledTask(store, taskId),
    byWebhookTrigger: (triggerId) => deps.sessionService.getSessionsByWebhookTrigger(store, triggerId),
    forScheduledExecution: (taskId, executionAt) =>
      deps.sessionService.getSessionForScheduledExecution(store, taskId, executionAt),
    recordActivity: async (...args) => deps.recordSessionActivity(store, ...args),
    recordRuntime: async (sessionId, runtime) => live.recordRuntime(sessionId, runtime),

    subagents: (sessionId, options) => deps.transcripts.listSubagents(store, sessionId, options),
    subagentTranscript: (sessionId, subagentId) => deps.transcripts.readSubagentTranscript(store, sessionId, subagentId),
    workflowTree: (sessionId, runId) => deps.transcripts.readWorkflowTree(store, sessionId, runId),
    workflowAgentTranscript: (sessionId, runId, workflowAgentId) =>
      deps.transcripts.readWorkflowAgentTranscript(store, sessionId, runId, workflowAgentId),
    copyDerivedFiles: (sourceId, targetId) => deps.transcripts.copyDerivedSessionFiles(store, sourceId, targetId),

    // Creating a session delivers its first message: a refusal reads as a delivery's does.
    create: (options) =>
      client().createSession(options).catch((error: unknown) => {
        throw error instanceof MessageNotAcceptedError ? notAcceptedError(error) : error
      }),
    start: (request) => delivery.start(request),
    fork: (sessionId) => client().forkSession(sessionId),
    deleteLive: (sessionId) => client().deleteSession(sessionId),
    warm: (sessionId) => client().warmSession(sessionId),

    live: async (sessionId) => ({
      activity: live.activity(sessionId),
      isActive: live.isActive(sessionId),
      isAwaitingInput: live.isAwaitingInput(sessionId),
      streamAttached: live.isSubscribed(sessionId),
      openRequests: state.inputRequests.getOpenRequestsForSession(sessionId),
      runtime: live.runtime(sessionId) ?? null,
    }),
    markActive: async (sessionId) => live.markActive(sessionId),
    markIdle: async (sessionId) => {
      // Going idle is the last moment the session was busy.
      deps.containerHost.runtime(slug).noteSessionActivity()
      live.markIdle(sessionId)
    },
    stopTask: (sessionId, taskId) => client().stopTask(sessionId, taskId),
    waitForIdle: (sessionId, opts) => live.waitForIdle(sessionId, opts),
    broadcastUpdate: async (sessionId) => live.emit(sessionId, { type: 'session_updated' }),
    reconcileTranscript: async (sessionId, toolCalls) => live.reconcileTranscript(sessionId, toolCalls),
    promoteAutomated: (sessionId, metadata) => live.promoteAutomated(sessionId, metadata),
    grantCapability: async (sessionId, capability) => live.grantCapability(sessionId, capability),

    attach: (sessionId, options) => delivery.attach(sessionId, options),

    deferNaming: async (sessionId) => {
      state.deferredNaming.add(sessionId)
    },
    takeDeferredNaming: async (sessionId) => state.deferredNaming.delete(sessionId),
  }
}

function createMessageOps(
  slug: AgentSlug,
  store: SessionStore,
  live: LiveSessions,
  delivery: SessionDelivery,
  deps: LocalActorDeps,
): MessageOps {
  const client = () => deps.containerHost.runtime(slug).getClient()
  return {
    deliver: (request) => delivery.deliver(request),
    // A message held while the session recovers never reached the container.
    cancelQueued: async (sessionId, uuid) => live.dropCoalesced(sessionId, uuid) || client().cancelQueuedMessage(sessionId, uuid),
    stop: (sessionId, options) => delivery.stop(sessionId, options),

    withCompact: (sessionId) => deps.sessionService.getSessionMessagesWithCompact(store, sessionId),
    page: (sessionId, opts) => deps.sessionService.getSessionMessagesPage(store, sessionId, opts),
    delta: (sessionId, opts) => deps.sessionService.getSessionMessagesDelta(store, sessionId, opts),
    findLastEntry: (sessionId, query, options) =>
      deps.sessionService.findLastSessionEntry(store, sessionId, matchesTranscriptQuery(query), options),
    remove: (sessionId, messageUuid) => deps.sessionService.removeMessage(store, sessionId, messageUuid),
    removeToolCall: (sessionId, toolCallId) => deps.sessionService.removeToolCall(store, sessionId, toolCallId),
    appendAssistant: (sessionId, text) => deps.appendAssistantEntry(store, sessionId, text),
    forkedUserUuids: (sessionId) => deps.transcripts.forkedUserUuids(store, sessionId),
    carryOver: (sessionIds) => deps.transcripts.readConversationCarryOver(store, sessionIds),
    rawLog: (sessionId) => deps.transcripts.openRawLog(store, sessionId),
    media: (...args) => deps.transcripts.openMedia(store, ...args),

    subscribe: async (sessionId) => sessionEvents(live, sessionId),
    follow: (sessionId, { after }) => sessionFrames(live, sessionId, after),
    broadcastEvent: async (sessionId, data) => live.emit(sessionId, data as SessionEvent),
  }
}

function createInputOps(slug: AgentSlug, state: AgentState, deps: LocalActorDeps): InputOps {
  const requests = state.inputRequests
  // A settled request may have been what a session waited on.
  const resolve = (id: string, outcome: UserInputRequestOutcome) => {
    const resolved = requests.resolve(id, outcome)
    state.sessions.syncAwaiting()
    return resolved
  }
  return {
    register: async (input, options) =>
      options?.unlessRecentlyResolved && input.id && requests.getRecentResolution(input.id) ? null : requests.register(input),
    get: async (id) => requests.getOpenRequest(id),
    claim: async (id, options) => requests.claimRequest(id, options?.leaseMs),
    releaseClaim: async (id, token) => requests.releaseClaim(id, token),
    answer: (id, value) => answerRequest(slug, state, deps, id, value),
    resolve: async (id, outcome) => resolve(id, outcome),
    recentResolution: async (id) => requests.getRecentResolution(id),
    snapshot: async (sessionId) => requests.getSnapshotForScope(sessionId),
    enrich: async (id, kind, enrichment) => requests.enrichOpenRequestPayload(id, kind, enrichment),

    complete: async (sessionId, toolUseId, outcome) => state.sessions.completeRequest(sessionId, toolUseId, outcome),
    completeCapabilityReview: async (sessionId, toolUseId, outcome) =>
      state.sessions.completeCapabilityReview(sessionId, toolUseId, outcome),
    cancelAwaiting: (sessionId) => state.sessions.cancelAwaitingInput(sessionId),

    reviews: createReviewOps(slug, deps),
    computerUse: createComputerUseOps(state, deps),
    mcpReauth: createMcpReauthOps(slug, deps, resolve),
    accountReauth: createAccountReauthOps(slug, deps, resolve),
  }
}

/** `inputs.answer`: one decision's whole run, holding the request's claim (see `InputOps.answer`). */
async function answerRequest(
  slug: AgentSlug,
  state: AgentState,
  deps: LocalActorDeps,
  id: string,
  value: unknown,
): ReturnType<InputOps['answer']> {
  const requests = state.inputRequests
  if (!requests.getOpenRequest(id)) return 'not-open'
  const claim = requests.claimRequest(id)
  if (!claim) return 'claimed'
  try {
    const runtime = deps.containerHost.runtime(slug)
    await runtime.ensureRunning()
    // A decision on another surface settles the request without the claim.
    // Settled while the container started, the container has nothing parked:
    // answering now would buffer a result nothing ever collects.
    if (!requests.getOpenRequest(id)) return 'not-open'
    const response = await runtime.getClient().fetch(`/inputs/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    })
    if (!response.ok) {
      console.error(`[LocalAgentActor] The container would not take the answer to ${id}: ${response.status} ${await response.text().catch(() => '')}`)
      return 'undeliverable'
    }
    state.sessions.completeRequest(undefined, id, 'answered')
    return 'answered'
  } finally {
    // Settling dropped the claim with the request; this matters only to a run that did not settle it.
    requests.releaseClaim(id, claim.token)
  }
}

// The review and re-auth ops go through their routers rather than the store
// the actor holds. The router is the process-wide API for these (the proxy
// routes, the mock container client and startup call it with a slug), and it
// dispatches straight back to this actor's store; the actor's ops are the
// agent-scoped face of the same API. The store is still the actor's: it is
// created with the handle and released with it.

function createReviewOps(slug: AgentSlug, deps: LocalActorDeps): ReviewOps {
  return {
    get: async (id) => deps.reviewManager.getPendingReviewsForAgent(slug).find((review) => review.id === id) ?? null,
    submit: async (id, decision, reason) => deps.reviewManager.submitDecision(slug, id, decision, reason),
    resolveMatching: async (scope, decision) => deps.reviewManager.resolveMatchingPending(slug, scope, decision),
    resolveMatchingByLabel: async (label, decision) =>
      deps.reviewManager.resolveMatchingPendingByLabel(slug, label, decision),
    resolveMatchingXAgent: async (operation, decision) =>
      deps.reviewManager.resolveMatchingXAgentByOperation(slug, operation, decision),
    request: (details, options) => deps.reviewManager.request(slug, details, options),
    requestXAgent: (request, options) => deps.reviewManager.requestXAgent(slug, request, options),
    withdraw: async (id) => deps.reviewManager.withdraw(slug, id),
    resume: (id) => deps.reviewManager.resume(slug, id),
    settle: (id, decision) => deps.reviewManager.settle(slug, id, decision),
    takeDenyReason: (id) => deps.reviewManager.takeDenyReason(slug, id),
  }
}

function createComputerUseOps(state: AgentState, deps: LocalActorDeps): ComputerUseOps {
  const computerUse = state.computerUse
  return {
    releaseGrab: async (sessionId) => {
      const appName = computerUse.grabbed()
      computerUse.clearGrabbed()
      if (appName) computerUse.revoke('use_application', appName)
      state.sessions.emit(sessionId, { type: 'computer_use_grab_changed', app: null })
      return { appName }
    },
    setGrabbedApp: async (appName) => computerUse.setGrabbed(appName),
    clearGrabbedApp: async () => computerUse.clearGrabbed(),
    grant: async (...args) => computerUse.grant(...args),
    consumeOnce: async (...args) => computerUse.consumeOnce(...args),
    clearPending: async (...args) => state.sessions.clearComputerUseRequest(...args),
    run: (run) => runComputerUse(state.hostRuns, deps.host, run),
    runScript: (run) => runScript(state.hostRuns, deps.host, run),
  }
}

/** The agent's container runtime, as its live sessions reach it. */
function createSessionsRuntime(slug: AgentSlug, deps: LocalActorDeps): SessionsRuntime {
  const runtime = () => deps.containerHost.runtime(slug)
  return {
    client: () => runtime().getClient(),
    fatalResult: (client, kind) => runtime().fatalResult(client, kind),
    unexpectedDeath: (sessionId) => runtime().handleUnexpectedDeath(sessionId ? [sessionId] : undefined),
    stopAfterFatalError: () => {
      console.log(`[LocalAgentActor] Stopping container for ${slug} after a fatal error`)
      background(
        runtime()
          .stopContainer()
          .catch((err) => console.error(`[LocalAgentActor] Failed to stop container for ${slug}:`, err)),
        { name: 'local-agent-actor.stop-after-fatal-error' },
      )
    },
  }
}

function createLockOps(state: AgentState): LockOps {
  const locks = state.locks
  return {
    tryAcquire: async (key) => locks.tryAcquire(key),
    acquire: (key) => locks.acquire(key),
    release: async (key, token) => locks.release(key, token),
  }
}

function createWidgetOps(state: AgentState): WidgetOps {
  const refreshes = state.widgetRefreshes
  return {
    beginRefresh: async (widgetSlug) => refreshes.begin(widgetSlug),
    beginOrJoinRefresh: (widgetSlug) => refreshes.beginOrJoin(widgetSlug),
    finishRefresh: async (widgetSlug, token, outcome) => refreshes.finish(widgetSlug, token, outcome),
    refreshing: async () => refreshes.refreshing(),
    refreshedAt: async () => refreshes.refreshedAt(),
    claimStaleSweep: async (throttleMs) => refreshes.claimStaleSweep(throttleMs),
    notePostRun: async () => refreshes.notePostRun(),
    isLatestPostRun: async (stamp) => refreshes.isLatestPostRun(stamp),
  }
}

function createMcpSessionOps(state: AgentState): McpSessionOps {
  const sessions = state.mcpSessions
  return {
    open: async (mcpId, protocolVersion) => sessions.open(mcpId, protocolVersion),
    get: async (mcpId, id) => sessions.get(mcpId, id),
    bind: async (id, upstreamSessionId) => sessions.bind(id, upstreamSessionId),
    unbind: async (id, upstreamSessionId) => sessions.unbind(id, upstreamSessionId),
    close: async (id) => sessions.close(id),
  }
}

function createVolumeUploadOps(state: AgentState): VolumeUploadOps {
  const uploads = state.volumeUploads
  return {
    begin: async (key) => uploads.begin(key),
    end: async (key, upload, outcome) => uploads.end(key, upload, outcome),
    allowDelete: async (key) => uploads.allowDelete(key),
  }
}

function createUsageOps(store: SessionStore, deps: LocalActorDeps): UsageOps {
  return {
    daily: (options) => deps.loadDailyUsageData({ files: store.files, dir: store.transcriptsDir, ...options }),
  }
}

type ResolveRequest = (id: string, outcome: UserInputRequestOutcome) => unknown

function createMcpReauthOps(slug: AgentSlug, deps: LocalActorDeps, resolve: ResolveRequest): McpReauthOps {
  return {
    request: (details, options) => deps.mcpReauthManager.request(slug, details, options),
    withdraw: async (waitId) => deps.mcpReauthManager.withdraw(slug, waitId),
    dismiss: async (entryId, ...rest) => deps.mcpReauthManager.dismiss(entryId, slug, ...rest),
    settleReplaced: async (entryId, replacementMcpId) => {
      if (deps.mcpReauthManager.replaceMcp(entryId, slug, replacementMcpId)) return 'released'
      resolve(entryId, 'answered')
      return 'resolved'
    },
    completeConnection: async (mcpId) => deps.mcpReauthManager.completeMcp(slug, mcpId),
  }
}

function createAccountReauthOps(slug: AgentSlug, deps: LocalActorDeps, resolve: ResolveRequest): AccountReauthOps {
  return {
    request: (details, options) => deps.accountReauthManager.request(slug, details, options),
    withdraw: async (waitId) => deps.accountReauthManager.withdraw(slug, waitId),
    dismiss: async (entryId, ...rest) => deps.accountReauthManager.dismiss(entryId, slug, ...rest),
    settleReplaced: async (entryId, replacementAccountId) => {
      if (deps.accountReauthManager.replaceAccount(entryId, slug, replacementAccountId)) return 'released'
      resolve(entryId, 'answered')
      return 'resolved'
    },
    completeAccount: async (accountId) => deps.accountReauthManager.completeAccount(slug, accountId),
  }
}
