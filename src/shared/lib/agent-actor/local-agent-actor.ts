import type { containerHost } from '@shared/lib/container/container-host'
import type { messagePersister } from '@shared/lib/container/message-persister'
import type { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import type { reviewManager } from '@shared/lib/proxy/review-manager'
import type { accountReauthManager } from '@shared/lib/proxy/account-reauth-manager'
import type { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import type { mcpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import type * as sessionService from '@shared/lib/services/session-service'
import type { appendAssistantEntry, appendInformationalEntry } from '@shared/lib/services/session-transcript-append'
import type { recordSessionActivity } from '@shared/lib/services/session-summary-cache'
import type * as transcriptOps from './local-transcript-ops'
import type { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import type {
  syncAgentConnectionEnvironment,
  updateConnectedAccountsEnvironment,
  updateRemoteMcpEnvironment,
} from '@shared/lib/container/connection-runtime-sync'
import type { loadDailyUsageData, loadSessionUsageTotals } from '@shared/lib/services/usage-service'
import { WebSocket } from 'ws'
import { createMemoryOps } from './memory-ops'
import { createAgentState, releaseAgentState, type AgentState } from './agent-state'
import { createLocalSessionStore } from './local-session-store'
import { transcriptPath, type SessionStore } from './session-store'
import type {
  AccountReauthOps,
  AgentActor,
  AgentSlug,
  ComputerUseOps,
  ConfigOps,
  ContainerOps,
  FileOps,
  InputOps,
  McpReauthOps,
  MessageOps,
  MemoryOps,
  ReviewOps,
  SessionOps,
  UsageOps,
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
 * state the actors own: the actor reports its request transitions to the
 * first, and the registry hands all of them the way to every actor's stores.
 */
export interface LocalActorDeps {
  readonly containerHost: typeof containerHost
  readonly messagePersister: typeof messagePersister
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
  readonly updateConnectedAccountsEnvironment: typeof updateConnectedAccountsEnvironment
  readonly updateRemoteMcpEnvironment: typeof updateRemoteMcpEnvironment
  readonly syncAgentConnectionEnvironment: typeof syncAgentConnectionEnvironment
  readonly loadDailyUsageData: typeof loadDailyUsageData
  readonly loadSessionUsageTotals: typeof loadSessionUsageTotals
}

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
  readonly container: ContainerOps
  readonly sessions: SessionOps
  readonly messages: MessageOps
  readonly inputs: InputOps
  readonly usage: UsageOps
  readonly files: FileOps
  readonly memories: MemoryOps
  readonly config: ConfigOps
  /** Where this agent's sessions are: the files, the config documents, the transcripts directory. */
  readonly store: SessionStore
  /**
   * What this agent holds in memory: its pending user-input requests, the
   * reviews and re-auth waits parked on them, its computer-use grants.
   * Created with the handle and released by `dispose`.
   */
  readonly state: AgentState

  constructor(readonly slug: AgentSlug, deps: LocalActorDeps) {
    // Every write to a session goes through the store, so this is where the
    // container's idle clock learns of session activity — the persister's
    // stream frames, the transcript appends and `sessions.recordActivity`
    // all record through it.
    this.store = createLocalSessionStore(slug, deps, {
      onActivity: (at) => deps.containerHost.runtime(slug).noteSessionActivity(at),
    })
    this.state = createAgentState(slug, {
      transitions: deps.userInputRequestManager,
      // A test double of the persister may not carry the projection; the real one does.
      syncAwaiting: () => deps.messagePersister.syncAgentSessionsAwaiting?.(slug),
    })
    this.files = this.store.files
    this.memories = createMemoryOps(this.files)
    this.config = this.store.config
    this.container = createContainerOps(slug, deps)
    this.sessions = createSessionOps(slug, this.store, deps)
    this.messages = createMessageOps(slug, this.store, deps)
    this.inputs = createInputOps(slug, this.state, deps)
    this.usage = createUsageOps(this.store, deps)
  }

  /** The registry is dropping this handle: release everything it owns. */
  dispose(): void {
    releaseAgentState(this.state)
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
    restart: async () => {
      await runtime().restartContainer()
    },
    keepAlive: () => runtime().keepAlive(),
    status: () => runtime().getCachedInfo(),
    syncStatus: () => runtime().syncAgentStatus(),
    health: () => runtime().getHealthWarnings(),
    stale: () => runtime().isStale(),
    idleSince: () => runtime().idleSince(),
    stats: () => client().getStats(),
    info: () => client().getInfo(),
    updateConnectedAccountsEnvironment: () => deps.updateConnectedAccountsEnvironment(slug, client()),
    updateRemoteMcpEnvironment: () => deps.updateRemoteMcpEnvironment(slug, client()),
    syncConnectionEnvironment: (kind) => deps.syncAgentConnectionEnvironment(slug, kind, runtime()),
    fetch: (...args) => client().fetch(...args),
    openWebSocket: (path, init) => {
      const info = runtime().getCachedInfo()
      if (info.status !== 'running' || !info.port) {
        throw new Error(`Container for agent ${slug} is not running`)
      }
      const c = client()
      return new WebSocket(`${c.getWebSocketBaseUrl(info.port)}${path}${init?.search ?? ''}`, init?.protocols, {
        headers: { ...init?.headers, ...c.getHostAuthHeaders() },
      })
    },
    hostBridgeIp: () => client().getHostBridgeIp(),
    probeHostPort: (host, port) => client().probeHostPortFromRunner(host, port),
  }
}

function createSessionOps(slug: AgentSlug, store: SessionStore, deps: LocalActorDeps): SessionOps {
  const client = () => deps.containerHost.runtime(slug).getClient()
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
    rename: (sessionId, name) => deps.sessionService.updateSessionName(store, sessionId, name),
    delete: (sessionId) => deps.sessionService.deleteSession(store, sessionId),
    deleteMany: (sessionIds) => deps.sessionService.deleteSessionsBatch(store, sessionIds),
    metadata: (sessionId) => deps.sessionService.getSessionMetadata(store, sessionId),
    readMetadata: () => deps.sessionService.readSessionMetadata(store),
    updateMetadata: (sessionId, updates) => deps.sessionService.updateSessionMetadata(store, sessionId, updates),
    finalizeAutomationStatus: (sessionId, status) =>
      deps.sessionService.finalizeAutomationStatus(store, sessionId, status),
    ensureDirectory: () => deps.sessionService.ensureSessionsDirectory(store),
    fileRealPathWithinAgent: (sessionId) => deps.sessionService.sessionFileRealPathWithinAgent(store, sessionId),
    usage: (sessionId, options) =>
      deps.loadSessionUsageTotals({ files: store.files, transcript: transcriptPath(store, sessionId), ...options }),
    byScheduledTask: (taskId) => deps.sessionService.getSessionsByScheduledTask(store, taskId),
    byWebhookTrigger: (triggerId) => deps.sessionService.getSessionsByWebhookTrigger(store, triggerId),
    forScheduledExecution: (taskId, executionAt) =>
      deps.sessionService.getSessionForScheduledExecution(store, taskId, executionAt),
    recordActivity: (...args) => deps.recordSessionActivity(store, ...args),

    subagents: (sessionId, options) => deps.transcripts.listSubagents(store, sessionId, options),
    subagentTranscript: (sessionId, subagentId) => deps.transcripts.readSubagentTranscript(store, sessionId, subagentId),
    workflowTree: (sessionId, runId) => deps.transcripts.readWorkflowTree(store, sessionId, runId),
    workflowAgentTranscript: (sessionId, runId, workflowAgentId) =>
      deps.transcripts.readWorkflowAgentTranscript(store, sessionId, runId, workflowAgentId),
    copyDerivedFiles: (sourceId, targetId) => deps.transcripts.copyDerivedSessionFiles(store, sourceId, targetId),

    create: (options) => client().createSession(options),
    fork: (sessionId) => client().forkSession(sessionId),
    deleteLive: (sessionId) => client().deleteSession(sessionId),

    activity: (sessionId) => deps.messagePersister.getSessionActivity(slug, sessionId),
    isActive: (sessionId) => deps.messagePersister.isSessionActive(slug, sessionId),
    isAwaitingInput: (sessionId) => deps.messagePersister.isSessionAwaitingInput(slug, sessionId),
    markActive: (sessionId) => deps.messagePersister.markSessionActive(slug, sessionId),
    markIdle: (sessionId) => {
      // Going idle is the last moment the session was busy.
      deps.containerHost.runtime(slug).noteSessionActivity()
      deps.messagePersister.markSessionIdle(slug, sessionId)
    },
    markInterrupted: (...args) => deps.messagePersister.markSessionInterrupted(slug, ...args),
    turnGeneration: (sessionId) => deps.messagePersister.getTurnGeneration(slug, sessionId),
    isWaitingBackground: (sessionId) => deps.messagePersister.isSessionWaitingBackground(slug, sessionId),
    hasOnlyUntrackedBackgroundWork: (sessionId) =>
      deps.messagePersister.hasOnlyUntrackedBackgroundWork(slug, sessionId),
    stopTask: (sessionId, taskId) => client().stopTask(sessionId, taskId),
    waitForIdle: (...args) => deps.messagePersister.waitForIdle(slug, ...args),
    activeIds: () => deps.messagePersister.getActiveSessionIdsForAgent(slug),
    hasActive: () => deps.messagePersister.hasActiveSessionsForAgent(slug),
    hasAwaitingInput: () => deps.messagePersister.hasSessionsAwaitingInputForAgent(slug),
    markAllInactive: (...args) => deps.messagePersister.markAllSessionsInactiveForAgent(slug, ...args),
    syncAwaiting: () => deps.messagePersister.syncAgentSessionsAwaiting(slug),
    broadcastUpdate: (sessionId) => deps.messagePersister.broadcastSessionUpdate(slug, sessionId),
    recoverAwaitingInput: (sessionId, unresolved) =>
      deps.messagePersister.recoverSessionAwaitingInput(slug, sessionId, unresolved),
    promoteAutomated: (sessionId) => deps.messagePersister.promoteAutomatedSession(slug, sessionId),
    grantCapability: (sessionId, capability) =>
      deps.messagePersister.grantSessionCapability(slug, sessionId, capability),
    slashCommands: (sessionId) => deps.messagePersister.getSlashCommands(slug, sessionId),
    setSlashCommands: (sessionId, commands) => deps.messagePersister.setSlashCommands(slug, sessionId, commands),
    backgroundTasks: (sessionId) => deps.messagePersister.getActiveBackgroundTasks(slug, sessionId),
    activeSubagents: (sessionId) => deps.messagePersister.getActiveSubagents(slug, sessionId),

    subscribeStream: (sessionId, containerSessionId) =>
      deps.messagePersister.subscribeToSession(slug, sessionId, client(), containerSessionId),
    unsubscribeStream: (sessionId) => deps.messagePersister.unsubscribeFromSession(slug, sessionId),
    isStreamSubscribed: (sessionId) => deps.messagePersister.isSubscribed(slug, sessionId),
  }
}

function createMessageOps(slug: AgentSlug, store: SessionStore, deps: LocalActorDeps): MessageOps {
  const client = () => deps.containerHost.runtime(slug).getClient()
  return {
    send: (...args) => client().sendMessage(...args),
    cancelQueued: (sessionId, uuid) => client().cancelQueuedMessage(sessionId, uuid),
    interrupt: (...args) => client().interruptSession(...args),
    withSend: (sessionId, send) => deps.messagePersister.withSessionSend(slug, sessionId, client(), send),

    list: (sessionId) => deps.sessionService.getSessionMessages(store, sessionId),
    withCompact: (sessionId) => deps.sessionService.getSessionMessagesWithCompact(store, sessionId),
    page: (sessionId, opts) => deps.sessionService.getSessionMessagesPage(store, sessionId, opts),
    delta: (sessionId, opts) => deps.sessionService.getSessionMessagesDelta(store, sessionId, opts),
    findLastEntry: (...args) => deps.sessionService.findLastSessionEntry(store, ...args),
    remove: (sessionId, messageUuid) => deps.sessionService.removeMessage(store, sessionId, messageUuid),
    removeToolCall: (sessionId, toolCallId) => deps.sessionService.removeToolCall(store, sessionId, toolCallId),
    appendInformational: (sessionId, entry) => deps.appendInformationalEntry(store, sessionId, entry),
    appendAssistant: (sessionId, text) => deps.appendAssistantEntry(store, sessionId, text),
    rawEntries: (sessionId) => deps.transcripts.streamRawEntries(store, sessionId),
    rawLog: (sessionId) => deps.transcripts.openRawLog(store, sessionId),
    media: (...args) => deps.transcripts.openMedia(store, ...args),

    subscribe: (sessionId, listener) => deps.messagePersister.addSSEClient(slug, sessionId, listener),
    broadcastEvent: (sessionId, data) => deps.messagePersister.broadcastSessionEvent(slug, sessionId, data),
    coalesceIfRecovering: (sessionId, message) =>
      deps.messagePersister.coalesceIfRecovering(slug, sessionId, message),
    dropCoalescedUserMessage: (sessionId, uuid) =>
      deps.messagePersister.dropCoalescedUserMessage(slug, sessionId, uuid),
  }
}

function createInputOps(slug: AgentSlug, state: AgentState, deps: LocalActorDeps): InputOps {
  const requests = state.inputRequests
  return {
    register: (input) => requests.register(input),
    open: (sessionId) => requests.getOpenRequestsForSession(sessionId),
    openForAgent: () => requests.getOpenRequests(),
    get: (id) => requests.getOpenRequest(id),
    claim: (id) => requests.claimRequest(id),
    releaseClaim: (id) => requests.releaseClaim(id),
    resolve: (id, outcome) => requests.resolve(id, outcome),
    recentResolution: (id) => requests.getRecentResolution(id),
    snapshot: (sessionId) => requests.getSnapshotForScope(sessionId),
    enrich: (id, kind, enrichment) => requests.enrichOpenRequestPayload(id, kind, enrichment),

    complete: (sessionId, toolUseId, outcome) =>
      deps.messagePersister.completeInputRequest(slug, sessionId, toolUseId, outcome),
    completeCapabilityReview: (...args) => deps.messagePersister.completeCapabilityReview(slug, ...args),
    cancelAwaiting: (sessionId) => deps.messagePersister.cancelAwaitingInput(slug, sessionId),
    settled: (sessionId) => deps.messagePersister.getSettledInputRequests(slug, sessionId),

    reviews: createReviewOps(slug, deps),
    computerUse: createComputerUseOps(slug, state, deps),
    mcpReauth: createMcpReauthOps(slug, deps),
    accountReauth: createAccountReauthOps(slug, deps),
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
    pending: () => deps.reviewManager.getPendingReviewsForAgent(slug),
    submit: (id, decision) => deps.reviewManager.submitDecision(id, decision, slug),
    denyAll: () => deps.reviewManager.denyAllForAgent(slug),
    resolveMatching: (scope, decision) => deps.reviewManager.resolveMatchingPending(slug, scope, decision),
    resolveMatchingByLabel: (label, decision) =>
      deps.reviewManager.resolveMatchingPendingByLabel(slug, label, decision),
    resolveMatchingXAgent: (operation, decision) =>
      deps.reviewManager.resolveMatchingXAgentByOperation(slug, operation, decision),
    request: (details, ...rest) => deps.reviewManager.requestReview({ ...details, agentSlug: slug }, ...rest),
    requestXAgent: (...args) => deps.reviewManager.requestXAgentReview(slug, ...args),
  }
}

function createComputerUseOps(slug: AgentSlug, state: AgentState, deps: LocalActorDeps): ComputerUseOps {
  const computerUse = state.computerUse
  return {
    grabbedApp: () => computerUse.grabbed(),
    setGrabbedApp: (appName) => computerUse.setGrabbed(appName),
    clearGrabbedApp: () => computerUse.clearGrabbed(),
    grant: (...args) => computerUse.grant(...args),
    consumeOnce: (...args) => computerUse.consumeOnce(...args),
    revokeGrant: (...args) => computerUse.revoke(...args),
    clearPending: (...args) => deps.messagePersister.clearPendingComputerUseRequest(slug, ...args),
  }
}

function createUsageOps(store: SessionStore, deps: LocalActorDeps): UsageOps {
  return {
    daily: (options) => deps.loadDailyUsageData({ files: store.files, dir: store.transcriptsDir, ...options }),
  }
}

function createMcpReauthOps(slug: AgentSlug, deps: LocalActorDeps): McpReauthOps {
  return {
    request: (details, ...rest) => deps.mcpReauthManager.requestReauth({ ...details, agentSlug: slug }, ...rest),
    dismiss: (entryId, ...rest) => deps.mcpReauthManager.dismiss(entryId, slug, ...rest),
    replace: (entryId, replacementMcpId) => deps.mcpReauthManager.replaceMcp(entryId, slug, replacementMcpId),
  }
}

function createAccountReauthOps(slug: AgentSlug, deps: LocalActorDeps): AccountReauthOps {
  return {
    request: (details, ...rest) =>
      deps.accountReauthManager.requestReauth({ ...details, agentSlug: slug }, ...rest),
    dismiss: (entryId, ...rest) => deps.accountReauthManager.dismiss(entryId, slug, ...rest),
    replace: (entryId, replacementAccountId) =>
      deps.accountReauthManager.replaceAccount(entryId, slug, replacementAccountId),
  }
}
