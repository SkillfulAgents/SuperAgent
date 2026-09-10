import type { containerManager } from '@shared/lib/container/container-manager'
import type { messagePersister } from '@shared/lib/container/message-persister'
import type { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import type { reviewManager } from '@shared/lib/proxy/review-manager'
import type { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import type { mcpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import type * as sessionService from '@shared/lib/services/session-service'
import type { appendInformationalEntry } from '@shared/lib/services/session-transcript-append'
import type { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import type {
  updateConnectedAccountsEnvironment,
  updateRemoteMcpEnvironment,
} from '@shared/lib/container/connection-runtime-sync'
import { createLocalFileOps } from './local-file-ops'
import type {
  AgentActor,
  AgentSlug,
  ComputerUseOps,
  ContainerOps,
  FileOps,
  InputOps,
  McpReauthOps,
  MessageOps,
  ReviewOps,
  SessionOps,
} from './types'

/**
 * What a local actor delegates to. Injected so the registry can be built
 * against fakes in tests and so the next PR can swap the container manager
 * for a per-actor container client without touching the ops.
 *
 * Every op reads its dependency from `deps` at call time, never at
 * construction, so a dependency is only touched by the call that uses it.
 */
export interface LocalActorDeps {
  readonly containerManager: typeof containerManager
  readonly messagePersister: typeof messagePersister
  readonly userInputRequestManager: typeof userInputRequestManager
  readonly reviewManager: typeof reviewManager
  readonly computerUsePermissionManager: typeof computerUsePermissionManager
  readonly mcpReauthManager: typeof mcpReauthManager
  readonly sessionService: typeof sessionService
  readonly appendInformationalEntry: typeof appendInformationalEntry
  readonly getAgentWorkspaceDir: typeof getAgentWorkspaceDir
  readonly updateConnectedAccountsEnvironment: typeof updateConnectedAccountsEnvironment
  readonly updateRemoteMcpEnvironment: typeof updateRemoteMcpEnvironment
}

/**
 * An agent whose container and files are managed by this process.
 *
 * Every method is a passthrough: one actor method, one underlying call, with
 * the agent's slug supplied. The ops are closures rather than class methods so
 * a caller may destructure them (`const { send } = actor.messages`).
 */
export class LocalAgentActor implements AgentActor {
  readonly container: ContainerOps
  readonly sessions: SessionOps
  readonly messages: MessageOps
  readonly inputs: InputOps
  readonly files: FileOps

  constructor(readonly slug: AgentSlug, deps: LocalActorDeps) {
    this.container = createContainerOps(slug, deps)
    this.sessions = createSessionOps(slug, deps)
    this.messages = createMessageOps(slug, deps)
    this.inputs = createInputOps(slug, deps)
    this.files = createLocalFileOps(slug, deps)
  }
}

function createContainerOps(slug: AgentSlug, deps: LocalActorDeps): ContainerOps {
  const client = () => deps.containerManager.getClient(slug)
  return {
    start: async () => {
      await deps.containerManager.ensureRunning(slug)
    },
    stop: (...args) => deps.containerManager.stopContainer(slug, ...args),
    restart: async () => {
      await deps.containerManager.restartContainer(slug)
    },
    keepAlive: () => deps.containerManager.keepAlive(slug),
    status: () => deps.containerManager.getCachedInfo(slug),
    syncStatus: () => deps.containerManager.syncAgentStatus(slug),
    health: () => deps.containerManager.getHealthWarnings(slug),
    startedAt: () => deps.containerManager.getContainerStartTime(slug),
    lastKeepAliveAt: () => deps.containerManager.getLastKeepAlive(slug),
    stats: () => client().getStats(),
    info: () => client().getInfo(),
    updateConnectedAccountsEnvironment: () => deps.updateConnectedAccountsEnvironment(slug, client()),
    updateRemoteMcpEnvironment: () => deps.updateRemoteMcpEnvironment(slug, client()),
    fetch: (...args) => client().fetch(...args),
    hostAuthHeaders: () => client().getHostAuthHeaders(),
    webSocketBaseUrl: (port) => client().getWebSocketBaseUrl(port),
    hostBridgeIp: () => client().getHostBridgeIp(),
    probeHostPort: (host, port) => client().probeHostPortFromRunner(host, port),
  }
}

function createSessionOps(slug: AgentSlug, deps: LocalActorDeps): SessionOps {
  const client = () => deps.containerManager.getClient(slug)
  return {
    list: (...args) => deps.sessionService.listSessions(slug, ...args),
    listFromSummary: (...args) => deps.sessionService.listSessionsFromSummary(slug, ...args),
    listByIds: (...args) => deps.sessionService.listSessionsByIds(slug, ...args),
    get: (...args) => deps.sessionService.getSession(slug, ...args),
    summary: () => deps.sessionService.getSessionSummary(slug),
    exists: (sessionId) => deps.sessionService.sessionExists(slug, sessionId),
    isKnown: (sessionId) => deps.sessionService.sessionIsKnown(slug, sessionId),
    isRegistered: (sessionId) => deps.sessionService.isSessionRegistered(slug, sessionId),
    register: (...args) => deps.sessionService.registerSession(slug, ...args),
    rename: (sessionId, name) => deps.sessionService.updateSessionName(slug, sessionId, name),
    delete: (sessionId) => deps.sessionService.deleteSession(slug, sessionId),
    deleteMany: (sessionIds) => deps.sessionService.deleteSessionsBatch(slug, sessionIds),
    metadata: (sessionId) => deps.sessionService.getSessionMetadata(slug, sessionId),
    readMetadata: () => deps.sessionService.readSessionMetadata(slug),
    updateMetadata: (sessionId, updates) => deps.sessionService.updateSessionMetadata(slug, sessionId, updates),
    finalizeAutomationStatus: (sessionId, status) =>
      deps.sessionService.finalizeAutomationStatus(slug, sessionId, status),
    ensureDirectory: () => deps.sessionService.ensureSessionsDirectory(slug),
    fileRealPathWithinAgent: (sessionId) => deps.sessionService.sessionFileRealPathWithinAgent(slug, sessionId),

    create: (options) => client().createSession(options),
    fork: (sessionId) => client().forkSession(sessionId),
    deleteLive: (sessionId) => client().deleteSession(sessionId),

    activity: (sessionId) => deps.messagePersister.getSessionActivity(slug, sessionId),
    isActive: (sessionId) => deps.messagePersister.isSessionActive(slug, sessionId),
    isAwaitingInput: (sessionId) => deps.messagePersister.isSessionAwaitingInput(slug, sessionId),
    markActive: (sessionId) => deps.messagePersister.markSessionActive(slug, sessionId),
    markIdle: (sessionId) => deps.messagePersister.markSessionIdle(slug, sessionId),
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
    recoverAwaitingInput: (sessionId, unresolved) =>
      deps.messagePersister.recoverSessionAwaitingInput(slug, sessionId, unresolved),
    promoteAutomated: (sessionId) => deps.messagePersister.promoteAutomatedSession(slug, sessionId),
    grantCapability: (sessionId, capability) =>
      deps.messagePersister.grantSessionCapability(slug, sessionId, capability),
    slashCommands: (sessionId) => deps.messagePersister.getSlashCommands(slug, sessionId),
    setSlashCommands: (sessionId, commands) => deps.messagePersister.setSlashCommands(slug, sessionId, commands),
    backgroundTasks: (sessionId) => deps.messagePersister.getActiveBackgroundTasks(slug, sessionId),

    subscribeStream: (sessionId, containerSessionId) =>
      deps.messagePersister.subscribeToSession(slug, sessionId, client(), containerSessionId),
    unsubscribeStream: (sessionId) => deps.messagePersister.unsubscribeFromSession(slug, sessionId),
    isStreamSubscribed: (sessionId) => deps.messagePersister.isSubscribed(slug, sessionId),
  }
}

function createMessageOps(slug: AgentSlug, deps: LocalActorDeps): MessageOps {
  const client = () => deps.containerManager.getClient(slug)
  return {
    send: (...args) => client().sendMessage(...args),
    cancelQueued: (sessionId, uuid) => client().cancelQueuedMessage(sessionId, uuid),
    interrupt: (...args) => client().interruptSession(...args),
    withSend: (sessionId, send) => deps.messagePersister.withSessionSend(slug, sessionId, client(), send),

    list: (sessionId) => deps.sessionService.getSessionMessages(slug, sessionId),
    withCompact: (sessionId) => deps.sessionService.getSessionMessagesWithCompact(slug, sessionId),
    page: (sessionId, opts) => deps.sessionService.getSessionMessagesPage(slug, sessionId, opts),
    delta: (sessionId, opts) => deps.sessionService.getSessionMessagesDelta(slug, sessionId, opts),
    findLastEntry: (...args) => deps.sessionService.findLastSessionEntry(slug, ...args),
    remove: (sessionId, messageUuid) => deps.sessionService.removeMessage(slug, sessionId, messageUuid),
    removeToolCall: (sessionId, toolCallId) => deps.sessionService.removeToolCall(slug, sessionId, toolCallId),
    appendInformational: (sessionId, entry) => deps.appendInformationalEntry(slug, sessionId, entry),

    subscribe: (sessionId, listener) => deps.messagePersister.addSSEClient(slug, sessionId, listener),
    broadcastEvent: (sessionId, data) => deps.messagePersister.broadcastSessionEvent(slug, sessionId, data),
    coalesceIfRecovering: (sessionId, message) =>
      deps.messagePersister.coalesceIfRecovering(slug, sessionId, message),
    dropCoalescedUserMessage: (sessionId, uuid) =>
      deps.messagePersister.dropCoalescedUserMessage(slug, sessionId, uuid),
  }
}

function createInputOps(slug: AgentSlug, deps: LocalActorDeps): InputOps {
  return {
    register: (input) => deps.userInputRequestManager.register(input),
    open: (sessionId) => deps.userInputRequestManager.getOpenRequestsForSession(slug, sessionId),
    openForAgent: () => deps.userInputRequestManager.getOpenRequestsForAgent(slug),
    get: (id) => deps.userInputRequestManager.getOpenRequest(id),
    claim: (id) => deps.userInputRequestManager.claimRequest(id),
    releaseClaim: (id) => deps.userInputRequestManager.releaseClaim(id),
    resolve: (id, outcome) => deps.userInputRequestManager.resolve(id, outcome),
    recentResolution: (id) => deps.userInputRequestManager.getRecentResolution(id),
    snapshot: (...args) => deps.userInputRequestManager.getSnapshotForScope(slug, ...args),
    enrich: (id, kind, enrichment) => deps.userInputRequestManager.enrichOpenRequestPayload(id, kind, enrichment),

    complete: (sessionId, toolUseId, outcome) =>
      deps.messagePersister.completeInputRequest(slug, sessionId, toolUseId, outcome),
    completeCapabilityReview: (...args) => deps.messagePersister.completeCapabilityReview(slug, ...args),
    cancelAwaiting: (sessionId) => deps.messagePersister.cancelAwaitingInput(slug, sessionId),
    settled: (sessionId) => deps.messagePersister.getSettledInputRequests(slug, sessionId),

    reviews: createReviewOps(slug, deps),
    computerUse: createComputerUseOps(slug, deps),
    mcpReauth: createMcpReauthOps(slug, deps),
  }
}

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

function createComputerUseOps(slug: AgentSlug, deps: LocalActorDeps): ComputerUseOps {
  return {
    grabbedApp: () => deps.computerUsePermissionManager.getGrabbedApp(slug),
    setGrabbedApp: (appName) => deps.computerUsePermissionManager.setGrabbedApp(slug, appName),
    clearGrabbedApp: () => deps.computerUsePermissionManager.clearGrabbedApp(slug),
    grant: (...args) => deps.computerUsePermissionManager.grantPermission(slug, ...args),
    consumeOnce: (...args) => deps.computerUsePermissionManager.consumeOnceGrant(slug, ...args),
    revokeGrant: (...args) => deps.computerUsePermissionManager.revokeGrant(slug, ...args),
    clearPending: (...args) => deps.messagePersister.clearPendingComputerUseRequest(slug, ...args),
  }
}

function createMcpReauthOps(slug: AgentSlug, deps: LocalActorDeps): McpReauthOps {
  return {
    request: (details, ...rest) => deps.mcpReauthManager.requestReauth({ ...details, agentSlug: slug }, ...rest),
    dismiss: (entryId, ...rest) => deps.mcpReauthManager.dismiss(entryId, slug, ...rest),
  }
}
