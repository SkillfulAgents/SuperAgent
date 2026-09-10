/**
 * Agent actor — the single entry point for everything that acts on one agent.
 *
 * `agentRegistry.get(slug)` returns an `AgentActor`: a handle with typed method
 * groups (`container`, `sessions`, `messages`, `inputs`, `files`). Consumers
 * outside `src/shared/lib/container/**` and this package talk to an agent only
 * through this handle; the container manager, message persister, and the
 * input/review/permission registries are internal to it.
 *
 * Every method here is a one-to-one passthrough to the underlying call. The
 * comment on each method names that call. Where a route composes several
 * calls today it composes the same actor methods; nothing is folded together.
 *
 * Two methods are synchronous snapshots of in-memory state —
 * `container.status()` and `sessions.activity()` — alongside the other
 * synchronous persister reads. Everything that does I/O returns a Promise.
 */
import type {
  ContainerInfo,
  ContainerSession,
  ContainerStats,
  CreateSessionOptions,
  HealthCheckResult,
  HostPortProbeResult,
  InterruptSessionOptions,
  InterruptSessionResult,
  SendMessageOptions,
  SlashCommandInfo,
  StopOptions,
} from '@shared/lib/container/types'
import type { CoalescedUserMessage } from '@shared/lib/container/runtime-death'
import type {
  JsonlMessageEntry,
  JsonlSystemEntry,
  SessionActivity,
  SessionInfo,
  SessionMetadata,
  SessionMetadataMap,
} from '@shared/lib/types/agent'
import type {
  AutomationStatusResult,
  ListSessionsOptions,
  SessionMessagesDelta,
  SessionMessagesPage,
} from '@shared/lib/services/session-service'
import type {
  PendingUserInputRequest,
  PendingUserInputRequestInput,
  UserInputRequestOutcome,
} from '@shared/lib/user-input/request-schema'
import type { SettledUserInputRequest } from '@shared/lib/user-input/request-manager'
import type { ReviewDetails } from '@shared/lib/proxy/review-manager'
import type { McpReauthDetails } from '@shared/lib/proxy/mcp-reauth-manager'
import type { ScopeLabel } from '@shared/lib/proxy/scope-metadata'
import type { ComputerUsePermissionLevel, PermissionGrantType } from '@shared/lib/computer-use/types'

/** The agent's directory-name slug. Not the URL `displaySlug`. */
export type AgentSlug = string

export interface AgentRegistry {
  /** Never fails and never does I/O; creates the handle on first use. */
  get(slug: AgentSlug): AgentActor
  /** The handle if `get` has been called for this slug and it was not evicted. */
  peek(slug: AgentSlug): AgentActor | undefined
  /** Handles for the agents whose container is currently running. */
  all(): AgentActor[]
  /** Drop the handle and its container client. Today's `containerManager.removeClient`. */
  evict(slug: AgentSlug): void
  /** Drop every handle and client. Today's `containerManager.clearClients`. */
  evictAll(): void
}

export interface AgentActor {
  readonly slug: AgentSlug
  readonly container: ContainerOps
  readonly sessions: SessionOps
  readonly messages: MessageOps
  readonly inputs: InputOps
  readonly files: FileOps
}

export interface ContainerOps {
  /** `containerManager.ensureRunning` — deduplicates in-flight starts. The client never leaves the actor. */
  start(): Promise<void>
  /** `containerManager.stopContainer` */
  stop(options?: StopOptions): Promise<void>
  /** `containerManager.restartContainer` */
  restart(): Promise<void>
  /** `containerManager.keepAlive` */
  keepAlive(): void
  /** `containerManager.getCachedInfo` — synchronous snapshot of the cached status. */
  status(): ContainerInfo
  /** `containerManager.syncAgentStatus` — refresh the cache from the runtime. */
  syncStatus(): Promise<ContainerInfo>
  /** `containerManager.getHealthWarnings` */
  health(): HealthCheckResult[]
  /** `containerManager.getContainerStartTime` */
  startedAt(): number | undefined
  /** `containerManager.getLastKeepAlive` */
  lastKeepAliveAt(): number | undefined
  /** `client.getStats` */
  stats(): Promise<ContainerStats | null>
  /** `client.getInfo` — queries the runtime; prefer `status()` unless freshness matters. */
  info(): Promise<ContainerInfo>
  /** `updateConnectedAccountsEnvironment` (connection-runtime-sync) with this agent's client. */
  updateConnectedAccountsEnvironment(): Promise<Response>
  /** `updateRemoteMcpEnvironment` (connection-runtime-sync) with this agent's client. */
  updateRemoteMcpEnvironment(): Promise<Response>

  // Escape hatches. These expose the container's transport to callers that
  // still speak to the container API directly. The lint fence counts them so
  // they can be burned down in later PRs.

  /** `client.fetch` */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** `client.getHostAuthHeaders` */
  hostAuthHeaders(): Record<string, string>
  /** `client.getWebSocketBaseUrl` */
  webSocketBaseUrl(port: number): string
  /** `client.getHostBridgeIp` */
  hostBridgeIp(): string | null
  /** `client.probeHostPortFromRunner` */
  probeHostPort(host: string, port: number): Promise<HostPortProbeResult>
}

export interface SessionOps {
  // Stored session data — session-service. Works without a running container.

  /** `listSessions` */
  list(options?: ListSessionsOptions): Promise<SessionInfo[]>
  /** `listSessionsFromSummary` */
  listFromSummary(options?: ListSessionsOptions & { metadata?: SessionMetadataMap }): Promise<SessionInfo[]>
  /** `listSessionsByIds` */
  listByIds(sessionIds: string[], options?: { excludeAutomated?: boolean }): Promise<SessionInfo[]>
  /** `getSession` */
  get(sessionId: string, already?: { metadata: SessionMetadata | null }): Promise<SessionInfo | null>
  /** `getSessionSummary` */
  summary(): Promise<{ sessionIds: string[]; sessionCount: number; lastActivityAt: Date | null }>
  /** `sessionExists` */
  exists(sessionId: string): Promise<boolean>
  /** `sessionIsKnown` */
  isKnown(sessionId: string): Promise<boolean>
  /** `isSessionRegistered` */
  isRegistered(sessionId: string): Promise<boolean>
  /** `registerSession` */
  register(sessionId: string, name?: string, initialMetadata?: Partial<SessionMetadata>): Promise<void>
  /** `updateSessionName` */
  rename(sessionId: string, name: string): Promise<void>
  /** `deleteSession` — the files are the authority. */
  delete(sessionId: string): Promise<boolean>
  /** `deleteSessionsBatch` */
  deleteMany(sessionIds: string[]): Promise<string[]>
  /** `getSessionMetadata` */
  metadata(sessionId: string): Promise<SessionMetadata | null>
  /** `readSessionMetadata` — the whole metadata map for the agent. */
  readMetadata(): Promise<SessionMetadataMap>
  /** `updateSessionMetadata` */
  updateMetadata(sessionId: string, updates: Partial<SessionMetadata>): Promise<SessionMetadata | undefined>
  /** `finalizeAutomationStatus` */
  finalizeAutomationStatus(sessionId: string, status: 'succeeded' | 'failed'): Promise<AutomationStatusResult>
  /** `ensureSessionsDirectory` */
  ensureDirectory(): Promise<void>
  /** `sessionFileRealPathWithinAgent` */
  fileRealPathWithinAgent(sessionId: string): boolean

  // Live sessions — ContainerClient. Needs the container.

  /** `client.createSession` */
  create(options: CreateSessionOptions): Promise<ContainerSession>
  /** `client.forkSession` */
  fork(sessionId: string): Promise<{ id: string } | null>
  /** `client.deleteSession` — the container's copy, not the stored files. */
  deleteLive(sessionId: string): Promise<boolean>

  // Activity — messagePersister. Synchronous reads of in-memory state.

  /** `messagePersister.getSessionActivity` — synchronous snapshot. */
  activity(sessionId: string): SessionActivity
  /** `messagePersister.isSessionActive` */
  isActive(sessionId: string): boolean
  /** `messagePersister.isSessionAwaitingInput` */
  isAwaitingInput(sessionId: string): boolean
  /** `messagePersister.markSessionActive` */
  markActive(sessionId: string): void
  /** `messagePersister.markSessionIdle` */
  markIdle(sessionId: string): void
  /** `messagePersister.markSessionInterrupted` */
  markInterrupted(sessionId: string, options?: { processKept?: boolean; turnGenerationBefore?: number }): Promise<void>
  /** `messagePersister.getTurnGeneration` — bumps per turn; read before an interrupt to tell a stale turn from the next one. */
  turnGeneration(sessionId: string): number
  /** `messagePersister.isSessionWaitingBackground` */
  isWaitingBackground(sessionId: string): boolean
  /** `messagePersister.hasOnlyUntrackedBackgroundWork` */
  hasOnlyUntrackedBackgroundWork(sessionId: string): boolean
  /** `client.stopTask` — stop one background task by its SDK task id. */
  stopTask(sessionId: string, taskId: string): Promise<boolean>
  /** `messagePersister.waitForIdle` */
  waitForIdle(
    sessionId: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal; requireActiveFirst?: boolean; observeMs?: number },
  ): Promise<void>
  /** `messagePersister.getActiveSessionIdsForAgent` */
  activeIds(): string[]
  /** `messagePersister.hasActiveSessionsForAgent` */
  hasActive(): boolean
  /** `messagePersister.hasSessionsAwaitingInputForAgent` */
  hasAwaitingInput(): boolean
  /** `messagePersister.markAllSessionsInactiveForAgent` */
  markAllInactive(options?: { settleRecovering?: boolean }): void
  /** `messagePersister.syncAgentSessionsAwaiting` */
  syncAwaiting(): void
  /** `messagePersister.recoverSessionAwaitingInput` */
  recoverAwaitingInput(sessionId: string, unresolved: Array<{ toolUseId: string; toolName: string }>): void
  /** `messagePersister.promoteAutomatedSession` */
  promoteAutomated(sessionId: string): Promise<void>
  /** `messagePersister.grantSessionCapability` */
  grantCapability(sessionId: string, capability: 'subagents' | 'workflows'): void
  /** `messagePersister.getSlashCommands` */
  slashCommands(sessionId: string): SlashCommandInfo[]
  /** `messagePersister.setSlashCommands` */
  setSlashCommands(sessionId: string, commands: SlashCommandInfo[]): void
  /** `messagePersister.getActiveBackgroundTasks` */
  backgroundTasks(sessionId: string): Array<{ taskId: string; startedAt: number; isWorkflow?: boolean; isSubagent?: boolean }>

  // Container stream attachment — messagePersister follows the container's
  // stream for a session and persists what arrives.

  /** `messagePersister.subscribeToSession` with this agent's client. */
  subscribeStream(sessionId: string, containerSessionId: string): Promise<void>
  /** `messagePersister.unsubscribeFromSession` */
  unsubscribeStream(sessionId: string): void
  /** `messagePersister.isSubscribed` */
  isStreamSubscribed(sessionId: string): boolean
}

export interface MessageOps {
  // Live — ContainerClient.

  /** `client.sendMessage` */
  send(sessionId: string, content: string, uuid?: string, options?: SendMessageOptions): Promise<void>
  /** `client.cancelQueuedMessage` */
  cancelQueued(sessionId: string, uuid: string): Promise<boolean>
  /** `client.interruptSession` */
  interrupt(sessionId: string, options?: InterruptSessionOptions): Promise<InterruptSessionResult>
  /** `messagePersister.withSessionSend` with this agent's client — brackets a send so a fast reply cannot land before the active mark. */
  withSend<T>(sessionId: string, send: () => Promise<T>): Promise<T>

  // Transcript reads and edits — session-service.

  /** `getSessionMessages` */
  list(sessionId: string): Promise<JsonlMessageEntry[]>
  /** `getSessionMessagesWithCompact` */
  withCompact(sessionId: string): Promise<(JsonlMessageEntry | JsonlSystemEntry)[]>
  /** `getSessionMessagesPage` */
  page(
    sessionId: string,
    opts: { limit: number; cursor?: string; signal?: AbortSignal; byteBudget?: number; media?: 'ref' },
  ): Promise<SessionMessagesPage>
  /** `getSessionMessagesDelta` */
  delta(sessionId: string, opts: { after: string; signal?: AbortSignal; media?: 'ref' }): Promise<SessionMessagesDelta>
  /** `findLastSessionEntry` */
  findLastEntry(
    sessionId: string,
    predicate: (entry: JsonlMessageEntry | JsonlSystemEntry) => boolean,
    options?: { endOffset?: number | null },
  ): Promise<JsonlMessageEntry | JsonlSystemEntry | null>
  /** `removeMessage` */
  remove(sessionId: string, messageUuid: string): Promise<boolean>
  /** `removeToolCall` */
  removeToolCall(sessionId: string, toolCallId: string): Promise<boolean>
  /** `appendInformationalEntry` (session-transcript-append) */
  appendInformational(sessionId: string, entry: { uuid: string; content: string; level?: string }): Promise<void>

  // Fan-out and recovery — messagePersister.

  /** `messagePersister.addSSEClient` — returns the unsubscribe function. */
  subscribe(sessionId: string, listener: (data: unknown) => void): () => void
  /** `messagePersister.broadcastSessionEvent` */
  broadcastEvent(sessionId: string, data: unknown): void
  /** `messagePersister.coalesceIfRecovering` */
  coalesceIfRecovering(sessionId: string, message: CoalescedUserMessage): boolean
  /** `messagePersister.dropCoalescedUserMessage` */
  dropCoalescedUserMessage(sessionId: string, uuid: string): boolean
}

export interface InputOps {
  // Open requests — userInputRequestManager. Requests are addressed by id;
  // the agent scope is carried by the request itself today.

  /** `userInputRequestManager.register` */
  register(input: PendingUserInputRequestInput): PendingUserInputRequest | null
  /** `userInputRequestManager.getOpenRequestsForSession` */
  open(sessionId: string): PendingUserInputRequest[]
  /** `userInputRequestManager.getOpenRequestsForAgent` */
  openForAgent(): PendingUserInputRequest[]
  /** `userInputRequestManager.getOpenRequest` */
  get(id: string): PendingUserInputRequest | null
  /** `userInputRequestManager.claimRequest` */
  claim(id: string): PendingUserInputRequest | null
  /** `userInputRequestManager.releaseClaim` */
  releaseClaim(id: string): void
  /** `userInputRequestManager.resolve` */
  resolve(id: string, outcome: UserInputRequestOutcome): PendingUserInputRequest | null
  /** `userInputRequestManager.getRecentResolution` */
  recentResolution(id: string): SettledUserInputRequest | undefined
  /** `userInputRequestManager.getSnapshotForScope` */
  snapshot(sessionId?: string): PendingUserInputRequest[]
  /** `userInputRequestManager.enrichOpenRequestPayload` */
  enrich(id: string, kind: PendingUserInputRequest['kind'], enrichment: Record<string, unknown>): boolean

  // Settlement — messagePersister.

  /** `messagePersister.completeInputRequest`. `sessionId` undefined = take it from the request's scope. */
  complete(sessionId: string | undefined, toolUseId: string, outcome: UserInputRequestOutcome): void
  /** `messagePersister.completeCapabilityReview` */
  completeCapabilityReview(sessionId: string, toolUseId: string, outcome?: UserInputRequestOutcome): void
  /** `messagePersister.cancelAwaitingInput` */
  cancelAwaiting(sessionId: string): Promise<void>
  /** `messagePersister.getSettledInputRequests` */
  settled(sessionId: string): Map<string, UserInputRequestOutcome>

  readonly reviews: ReviewOps
  readonly computerUse: ComputerUseOps
  readonly mcpReauth: McpReauthOps
}

/** Proxy scope reviews — reviewManager, scoped to this agent. */
export interface ReviewOps {
  /** `reviewManager.getPendingReviewsForAgent` */
  pending(): Array<{ id: string; displayText: string } & ReviewDetails>
  /** `reviewManager.submitDecision` with this agent as the expected owner. */
  submit(id: string, decision: 'allow' | 'deny'): boolean
  /** `reviewManager.denyAllForAgent` */
  denyAll(): void
  /** `reviewManager.resolveMatchingPending` */
  resolveMatching(scope: string, decision: 'allow' | 'deny'): void
  /** `reviewManager.resolveMatchingPendingByLabel` */
  resolveMatchingByLabel(label: ScopeLabel, decision: 'allow' | 'deny'): void
  /** `reviewManager.resolveMatchingXAgentByOperation` */
  resolveMatchingXAgent(operation: 'list' | 'read' | 'invoke' | 'create', decision: 'allow' | 'deny'): void
  /** `reviewManager.requestReview` with `agentSlug` set to this agent. */
  request(details: Omit<ReviewDetails, 'agentSlug'>, signal?: AbortSignal): Promise<'allow' | 'deny'>
  /** `reviewManager.requestXAgentReview` with this agent as the caller. */
  requestXAgent(
    targetAgentSlug: string,
    targetAgentName: string,
    operation: 'list' | 'read' | 'invoke' | 'create',
    preview?: string,
    signal?: AbortSignal,
  ): Promise<'allow' | 'deny'>
}

/** Computer-use permission grants — computerUsePermissionManager, scoped to this agent. */
export interface ComputerUseOps {
  /** `computerUsePermissionManager.getGrabbedApp` */
  grabbedApp(): string | undefined
  /** `computerUsePermissionManager.setGrabbedApp` */
  setGrabbedApp(appName: string): void
  /** `computerUsePermissionManager.clearGrabbedApp` */
  clearGrabbedApp(): void
  /** `computerUsePermissionManager.grantPermission` */
  grant(level: ComputerUsePermissionLevel, grantType: PermissionGrantType, appName?: string): void
  /** `computerUsePermissionManager.consumeOnceGrant` */
  consumeOnce(level: ComputerUsePermissionLevel, appName?: string): void
  /** `computerUsePermissionManager.revokeGrant` */
  revokeGrant(level: ComputerUsePermissionLevel, appName?: string): void
  /** `messagePersister.clearPendingComputerUseRequest` */
  clearPending(sessionId: string, toolUseId: string, outcome?: UserInputRequestOutcome): void
}

/** Remote MCP re-authentication prompts — mcpReauthManager, scoped to this agent. */
export interface McpReauthOps {
  /** `mcpReauthManager.requestReauth` with `agentSlug` set to this agent. */
  request(details: Omit<McpReauthDetails, 'agentSlug'>, signal?: AbortSignal): Promise<void>
  /** `mcpReauthManager.dismiss` */
  dismiss(entryId: string, reason?: string): boolean
}

/**
 * Workspace files. The `/files/*` route bodies (list, stat, read, write,
 * delete, mkdir) move in here when that route is ported; until then this
 * group only answers where the workspace is.
 */
export interface FileOps {
  /** `getAgentWorkspaceDir` — escape hatch, local runtime only; counted by the lint fence. */
  workspacePath(): string
}
