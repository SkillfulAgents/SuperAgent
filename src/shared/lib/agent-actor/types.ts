/**
 * Agent actor — the single entry point for everything that acts on one agent.
 *
 * `agentRegistry.get(slug)` returns an `AgentActor`: a handle with typed method
 * groups (`container`, `sessions`, `messages`, `inputs`, `files`, `memories`). Consumers
 * outside `src/shared/lib/container/**` and this package talk to an agent only
 * through this handle; the container manager, message persister, and the
 * input/review/permission stores are internal to it.
 *
 * Runtime methods delegate to the underlying call named by their comments.
 * Storage capabilities own their agent-scoped behavior, including memory
 * validation and save serialization; callers do not need the storage layout.
 *
 * The `inputs` group is the actor's own state: its pending user-input
 * requests, the reviews and re-auth waits parked on them, and its
 * computer-use grants live on the handle and are released when the registry
 * evicts it. The process-wide managers of those names are routers over the
 * actors' stores, for callers that hold an id or a slug but no handle.
 *
 * Two methods are synchronous snapshots of in-memory state —
 * `container.status()` and `sessions.activity()` — alongside the other
 * synchronous persister reads. Everything that does I/O returns a Promise.
 */
import type { XAgentFileTransfer } from '@shared/lib/proxy/x-agent-review'
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
import type { ActiveSubagentSnapshot } from '@shared/lib/container/message-persister'
import type { WebSocket } from 'ws'
import type { ConnectionRuntimeKind } from '@shared/lib/container/connection-runtime-sync'
import type { CommonLoadOptions, DailyUsageData } from '@shared/lib/services/usage-service'
import type { SessionUsageTotals } from '@shared/lib/types/usage'
import type {
  JsonlEntry,
  JsonlMessageEntry,
  JsonlSystemEntry,
  SessionActivity,
  SessionInfo,
  SessionMetadata,
  SessionMetadataMap,
} from '@shared/lib/types/agent'
import type { MediaRef } from '@shared/lib/services/session-media'
import type { WorkflowTree } from '@shared/lib/workflows/workflow-schemas'
import type { ConfigDoc, ConfigDocId } from './config-schema'
import type { AgentMemoryDocument, AgentMemoryEntry } from '@shared/lib/types/memory'
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
import type { SettledUserInputRequest } from '@shared/lib/user-input/agent-input-requests'
import type { ReviewDetails } from '@shared/lib/proxy/review-manager'
import type { AccountReauthDetails } from '@shared/lib/proxy/account-reauth-manager'
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
  /**
   * Handles for the agents whose container is currently running. Not "every
   * agent": a cross-agent read that wants all agents iterates the agent list.
   */
  running(): AgentActor[]
  /**
   * Drop the handle and forget its container runtime, releasing everything
   * the handle owns: parked reviews and re-auth waits are rejected, open
   * input requests are settled as invalidated, in-memory grants and the
   * summary cache are gone. Does not stop the container.
   */
  evict(slug: AgentSlug): void
  /** `evict` for every handle. Does not stop containers. */
  evictAll(): void
}

export interface AgentActor {
  readonly slug: AgentSlug
  readonly container: ContainerOps
  readonly sessions: SessionOps
  readonly messages: MessageOps
  readonly inputs: InputOps
  readonly usage: UsageOps
  readonly files: FileOps
  readonly memories: MemoryOps
  readonly config: ConfigOps
}

/** The agent's persistent memories. Paths are relative to its memory directory. */
export interface MemoryOps {
  /** All Markdown memories, including the index; an absent directory is empty. */
  list(): Promise<AgentMemoryEntry[]>
  /** One complete memory and its revision; absent files raise MemoryError. */
  read(path: string): Promise<AgentMemoryDocument>
  /** Validate and save an existing memory if its revision still matches. */
  save(path: string, content: string, revision: string): Promise<AgentMemoryDocument>
}

/** Where an agent's workspace lives. */
export interface AgentPlacement {
  /** 'local' for a directory under the agents data directory; a provider name otherwise. */
  runtime: string
  /** The provider's handle for a workspace held elsewhere; null for a local one. */
  workspaceHandle: string | null
}

/** One agent as the catalog knows it: identity and placement, never contents. */
export interface AgentRecord {
  slug: AgentSlug
  name: string
  description?: string
  createdAt: Date
  placement: AgentPlacement
}

export interface AgentIdentityChanges {
  name?: string
  /** Null clears the description. */
  description?: string | null
}

/**
 * Which agents exist and what they are called. Host level, like
 * `ContainerHost`: an actor is about one agent, this is about the set, and
 * creating or removing an agent is an operation on the set. Reading or
 * writing an agent's contents goes through its actor.
 *
 * The catalog is the authority for an agent's name and description. The
 * agent's `AGENTS.md` carries a frontmatter projection of them, written by
 * the host, so the agent still sees who it is and exports still carry it.
 */
export interface AgentCatalog {
  /** Every agent slug on this host, newest first. */
  list(): Promise<AgentSlug[]>
  /** Every agent, newest first. */
  records(): Promise<AgentRecord[]>
  /** The agent for a slug, or null when there is no such agent. */
  get(slug: AgentSlug): Promise<AgentRecord | null>
  /** The agents for these slugs, newest first; unknown slugs are skipped. */
  getMany(slugs: AgentSlug[]): Promise<AgentRecord[]>
  exists(slug: AgentSlug): Promise<boolean>
  /** A fresh, unused agent slug. Nothing exists until `insert` records it. */
  mint(): Promise<AgentSlug>
  /** Record a new local agent. The caller has written its workspace already. */
  insert(record: { slug: AgentSlug; name: string; description?: string; createdAt: Date }): Promise<AgentRecord>
  /** Change an agent's name or description; null when there is no such agent. */
  update(slug: AgentSlug, changes: AgentIdentityChanges): Promise<AgentRecord | null>
  /** The agent slug for a display slug or a slug, or null when there is no such agent. */
  resolve(input: string): Promise<AgentSlug | null>
  /** Remove an agent and everything it owns. The caller stops its container first. */
  remove(slug: AgentSlug): Promise<void>
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
  /** `ContainerRuntime.isStale` — running on a container env that a setting change replaced. */
  stale(): boolean
  /**
   * When this agent last stopped being busy, as epoch ms, or `null` while it
   * is busy or its idleness is unknown. Busy is any session active or
   * awaiting input. Otherwise it is the latest of the container start, the
   * last `keepAlive()` and the last session activity (a message sent, a frame
   * received, a transcript write), and `null` when none has been recorded
   * since the container last stopped.
   *
   * The actor puts itself to sleep: each of those events re-arms its own
   * alarm for the auto-sleep timeout, and the alarm sleeps the container
   * once `idleSince() !== null && now - idleSince() > timeout`. A local actor
   * uses a timer on the runtime; a remote one uses its host's alarm. This op
   * is the clock the alarm reads, answered from memory, exposed so a status
   * view or a fallback sweep can read it too.
   */
  idleSince(): number | null
  /** `client.getStats` */
  stats(): Promise<ContainerStats | null>
  /** `client.getInfo` — queries the runtime; prefer `status()` unless freshness matters. */
  info(): Promise<ContainerInfo>
  /** `updateConnectedAccountsEnvironment` (connection-runtime-sync) with this agent's client. */
  updateConnectedAccountsEnvironment(): Promise<Response>
  /** `updateRemoteMcpEnvironment` (connection-runtime-sync) with this agent's client. */
  updateRemoteMcpEnvironment(): Promise<Response>
  /**
   * `syncAgentConnectionEnvironment` (connection-runtime-sync) — push one
   * projection to a running container. True when it was applied or when the
   * container is stopped (startup rebuilds it); false on a failed push.
   */
  syncConnectionEnvironment(kind: ConnectionRuntimeKind): Promise<boolean>

  // Transport to the container API. These are honest for any runtime: a
  // remote actor answers them over the network the same way.

  /** `client.fetch` — an HTTP request to the container API. Counted by the lint fence until its direct callers move inward. */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /**
   * A WebSocket to the container API at `path`, authenticated the way `fetch`
   * is. Returned before it opens so the caller attaches its own listeners.
   * Throws when the container is not running.
   */
  openWebSocket(path: string, init?: OpenWebSocketInit): WebSocket

  // Host capabilities. These describe the machine running the API, not the
  // container's transport: an actor whose container is elsewhere answers
  // null / 'unknown', and callers gate on that.

  /** `client.getHostBridgeIp` — the address the container reaches this host on, if any. */
  hostBridgeIp(): string | null
  /** `client.probeHostPortFromRunner` — whether the container's network can reach a port on this host. */
  probeHostPort(host: string, port: number): Promise<HostPortProbeResult>
}

export interface OpenWebSocketInit {
  /** Query string including the leading `?`. */
  search?: string
  /** WebSocket subprotocols to offer. */
  protocols?: string | string[]
  /** Extra request headers. The container's auth headers are added after these and win. */
  headers?: Record<string, string>
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
  /** `sessionFileRealPathWithinAgent` — the transcript's real location is inside the workspace, links followed. */
  fileRealPathWithinAgent(sessionId: string): Promise<boolean>
  /** `loadSessionUsageTotals` (usage-service) over this session's transcript and the files beside it. */
  usage(sessionId: string): Promise<SessionUsageTotals>
  /** `getSessionsByScheduledTask` */
  byScheduledTask(scheduledTaskId: string): Promise<SessionInfo[]>
  /** `getSessionsByWebhookTrigger` */
  byWebhookTrigger(webhookTriggerId: string): Promise<SessionInfo[]>
  /** `getSessionForScheduledExecution` */
  forScheduledExecution(scheduledTaskId: string, scheduledExecutionAt: Date): Promise<SessionInfo | null>
  /** `recordSessionActivity` (session-summary-cache) — a transcript write happened that no stream frame will report. */
  recordActivity(sessionId: string, activityAt?: Date | number): void

  // Files derived from a session's transcript: subagent and workflow
  // transcripts live beside it. Read by the routes that render them.

  /**
   * The subagents a session launched, from their sidecar metadata. `except`
   * names the ones the caller already knows: their sidecars are not read and
   * they are not returned, so resolving one interrupted launch in a history
   * of a hundred settled ones reads one sidecar, not a hundred.
   */
  subagents(sessionId: string, options?: { except?: ReadonlySet<string> }): Promise<SubagentRef[]>
  /** One subagent's transcript entries; empty when there is none. */
  subagentTranscript(sessionId: string, subagentId: string): Promise<JsonlEntry[]>
  /** `buildWorkflowTree` (workflow-tree) for one dynamic-workflow run, or null when the run is unknown. */
  workflowTree(sessionId: string, runId: string): Promise<WorkflowTree | null>
  /** One workflow agent's transcript entries; empty when there is none. */
  workflowAgentTranscript(sessionId: string, runId: string, workflowAgentId: string): Promise<JsonlEntry[]>
  /** Copy the derived files (subagent and workflow transcripts) of one session to another; nothing to copy is a no-op. */
  copyDerivedFiles(sourceSessionId: string, targetSessionId: string): Promise<void>

  // Live sessions — ContainerClient. Needs the container.

  /** Inspect the running container session, including whether a send was accepted. */
  getLive(sessionId: string): Promise<ContainerSession | null>
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
  /** Mark active for stream recovery; undo only if no new send, turn, or output took ownership. */
  markProvisionalActive(sessionId: string): () => void
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
  /**
   * `messagePersister.broadcastSessionUpdate`: tell the session's stream
   * listeners that its metadata changed (a rename, a model or effort change)
   * so they refetch before their next send.
   */
  broadcastUpdate(sessionId: string): void
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
  /** `messagePersister.getActiveSubagents` — running and completed subagents for the current turn. */
  activeSubagents(sessionId: string): ActiveSubagentSnapshot[]

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
  /** `appendAssistantEntry` (session-transcript-append) — an assistant message delivered out of band, recorded so the transcript shows it. */
  appendAssistant(sessionId: string, text: string): Promise<void>
  /** `streamJsonlFile` over the transcript — every raw entry, in order. */
  rawEntries(sessionId: string): AsyncIterable<unknown>
  /** The transcript file's bytes for the debug view, or null when there is no transcript. */
  rawLog(sessionId: string): Promise<{ size: number; stream: ReadableStream<Uint8Array> } | null>
  /** `openMediaBlob` (session-media) — one media item referenced from the transcript, or undefined when it is gone. */
  media(sessionId: string, ref: MediaRef, signal?: AbortSignal): Promise<MediaBlob | undefined>

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
  // Open requests — the agent's own `AgentInputRequests` store, owned by the
  // actor and released with it. `register` stamps this agent onto the
  // request's scope, and an id-addressed method can only find a request this
  // agent holds: another agent's request is not found (null, false, or a
  // no-op) because it is not here, not because a filter hid it.

  /** `AgentInputRequests.register` with `scope.agentSlug` set to this agent. */
  register(input: PendingUserInputRequestInput): PendingUserInputRequest | null
  /** `AgentInputRequests.getOpenRequestsForSession` */
  open(sessionId: string): PendingUserInputRequest[]
  /** `AgentInputRequests.getOpenRequests` — session-scoped and agent-scoped entries. */
  openForAgent(): PendingUserInputRequest[]
  /** `AgentInputRequests.getOpenRequest` */
  get(id: string): PendingUserInputRequest | null
  /** `AgentInputRequests.claimRequest` */
  claim(id: string): PendingUserInputRequest | null
  /** `AgentInputRequests.releaseClaim` */
  releaseClaim(id: string): void
  /** `AgentInputRequests.resolve` */
  resolve(id: string, outcome: UserInputRequestOutcome): PendingUserInputRequest | null
  /** `AgentInputRequests.getRecentResolution` */
  recentResolution(id: string): SettledUserInputRequest | undefined
  /** `AgentInputRequests.getSnapshotForScope` */
  snapshot(sessionId?: string): PendingUserInputRequest[]
  /** `AgentInputRequests.enrichOpenRequestPayload` */
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
  readonly accountReauth: AccountReauthOps
}

/** Proxy scope reviews — the agent's own `AgentReviews`, owned by the actor. */
export interface ReviewOps {
  /** `AgentReviews.pending` */
  pending(): Array<{ id: string; displayText: string } & ReviewDetails>
  /** `AgentReviews.submit` — only a review this agent holds can be found. */
  submit(id: string, decision: 'allow' | 'deny'): boolean
  /** `AgentReviews.denyAll` */
  denyAll(): void
  /** `AgentReviews.resolveMatching` */
  resolveMatching(scope: string, decision: 'allow' | 'deny'): void
  /** `AgentReviews.resolveMatchingByLabel` */
  resolveMatchingByLabel(label: ScopeLabel, decision: 'allow' | 'deny'): void
  /** `AgentReviews.resolveMatchingXAgent` */
  resolveMatchingXAgent(operation: 'list' | 'read' | 'invoke' | 'create', decision: 'allow' | 'deny'): void
  /** `AgentReviews.request` — the review is this agent's. */
  request(details: Omit<ReviewDetails, 'agentSlug'>, signal?: AbortSignal): Promise<'allow' | 'deny'>
  /** `AgentReviews.requestXAgent` with this agent as the caller. */
  requestXAgent(
    targetAgentSlug: string,
    targetAgentName: string,
    operation: 'list' | 'read' | 'invoke' | 'create',
    preview?: string,
    fileTransfer?: XAgentFileTransfer,
    signal?: AbortSignal,
  ): Promise<'allow' | 'deny'>
}

/** Computer-use permission grants and the grabbed app — the agent's own `AgentComputerUse`, owned by the actor. */
export interface ComputerUseOps {
  /** `AgentComputerUse.grabbed` */
  grabbedApp(): string | undefined
  /** `AgentComputerUse.setGrabbed` */
  setGrabbedApp(appName: string): void
  /** `AgentComputerUse.clearGrabbed` */
  clearGrabbedApp(): void
  /** `AgentComputerUse.grant` */
  grant(level: ComputerUsePermissionLevel, grantType: PermissionGrantType, appName?: string): void
  /** `AgentComputerUse.consumeOnce` */
  consumeOnce(level: ComputerUsePermissionLevel, appName?: string): void
  /** `AgentComputerUse.revoke` */
  revokeGrant(level: ComputerUsePermissionLevel, appName?: string): void
  /** `messagePersister.clearPendingComputerUseRequest` */
  clearPending(sessionId: string, toolUseId: string, outcome?: UserInputRequestOutcome): void
}

/** Remote MCP re-authentication prompts — the agent's own `AgentReauthWaits`, owned by the actor. */
export interface McpReauthOps {
  /** `AgentReauthWaits.request` — the wait is this agent's. */
  request(details: Omit<McpReauthDetails, 'agentSlug'>, signal?: AbortSignal): Promise<void>
  /** `AgentReauthWaits.dismiss` — false when this agent holds no such card. */
  dismiss(entryId: string, reason?: string): boolean
  /** `AgentReauthWaits.replace` — settle the wait with a different connection. */
  replace(entryId: string, replacementMcpId: string): boolean
}

/** Connected-account re-authentication prompts — the agent's own `AgentReauthWaits`, owned by the actor. */
export interface AccountReauthOps {
  /** `AgentReauthWaits.request` — the wait is this agent's. */
  request(details: Omit<AccountReauthDetails, 'agentSlug'>, signal?: AbortSignal): Promise<void>
  /** `AgentReauthWaits.dismiss` — false when this agent holds no such card. */
  dismiss(entryId: string, reason?: string): boolean
  /** `AgentReauthWaits.replace` — release only this agent's calls; other agents still use the old account. */
  replace(entryId: string, replacementAccountId: string): boolean
}

/** Model usage read from this agent's transcripts — usage-service. */
export interface UsageOps {
  /** `loadDailyUsageData` over every transcript the CLI wrote for this agent. */
  daily(options?: CommonLoadOptions): Promise<DailyUsageData[]>
}

/** A subagent a session launched, as its sidecar metadata describes it. */
export interface SubagentRef {
  id: string
  /** The Task tool call that launched it, when the sidecar recorded one. */
  toolUseId?: string
}

/** One media item from a transcript, ready to serve. */
export interface MediaBlob {
  stream: ReadableStream<Uint8Array>
  mimeType: string
  bytes: number
}

export type FileKind = 'file' | 'directory'

/** One entry of a directory listing. `path` is the entry's own workspace path. */
export interface FileEntry {
  name: string
  path: string
  kind: FileKind
}

export interface FileStat {
  kind: FileKind
  size: number
  mtimeMs: number
  /**
   * The permission bits (`0o777`-masked), so a copy or an export can carry
   * them: a script that is executable in the workspace stays executable
   * where it lands. Absent from a store that keeps no modes.
   */
  mode?: number
  /**
   * When the file was created, where the store records that. Absent from a
   * store that does not, and 0 on a filesystem that reports no birth time.
   */
  birthtimeMs?: number
}

/** A closed byte range: both ends inclusive, as in an HTTP Range header. */
export interface ByteRange {
  start: number
  end: number
}

export interface WriteOptions {
  /** Refuse symlink escapes; used when sharing files across agents. */
  confined?: boolean
  /** Publish only if no destination exists, including racing writers. */
  overwrite?: boolean
  signal?: AbortSignal
  /**
   * File mode to apply. Advisory: a filesystem implementation applies it (the
   * container must be able to read `.env`), anything else ignores it.
   */
  mode?: number
  /**
   * For `write`: flush the file to disk before returning, as `putDoc` always
   * does. Off by default, because bulk content (an import of a thousand
   * files) was never flushed and a flush per file is what makes it slow; on
   * for the rewrite of a file that must survive a crash. A store that is
   * durable on return ignores it.
   */
  flush?: boolean
}

/**
 * The agent's configuration documents (see `config-schema.ts`), typed and
 * validated. A JSON document that does not parse or fit its schema is
 * `corrupt`: `get` throws `ConfigDocError` and an `update` aborts before
 * writing, so a broken file is never silently replaced.
 */
export interface ConfigOps {
  /** The document, or null when it does not exist yet. */
  get<K extends ConfigDocId>(id: K): Promise<ConfigDoc<K> | null>
  /** Validate and store a whole document atomically. */
  put<K extends ConfigDocId>(id: K, doc: ConfigDoc<K>): Promise<void>
  /**
   * Read-modify-write, serialized per document: no two updates interleave,
   * and for a document another process also writes, neither do theirs. A
   * mutator that returns null, or the document it was given, leaves the file
   * untouched; the result is the document as it stands afterwards, null when
   * there is none.
   */
  update<K extends ConfigDocId>(
    id: K,
    mutate: (current: ConfigDoc<K> | null) => ConfigDoc<K> | null | Promise<ConfigDoc<K> | null>,
  ): Promise<ConfigDoc<K> | null>
}

/**
 * Workspace files, by operation. Every path is a workspace path (see
 * `workspace-path.ts`): relative to the workspace root, posix, `/workspace/…`
 * accepted. Containment is lexical and lives inside the implementation: a
 * path that would leave the workspace (`..`, an absolute path) throws
 * `WorkspaceFileError` and touches nothing. Links are followed the way the
 * store follows them; `resolve` tells a caller where a path really leads.
 * Symbolic links are never listed.
 */
export interface FileOps {
  /** Immediate children of a directory (`''` is the root). Absent → `not-found`; a file → `not-a-directory`. */
  list(dir: string): Promise<FileEntry[]>
  /** What is at a path, or null when nothing is. */
  stat(path: string): Promise<FileStat | null>
  /**
   * The workspace path of what is really at `path`, links followed: null
   * when nothing is there, `outside-workspace` when it leads out of the
   * workspace. A store without links echoes the normalized path. For a
   * caller that serves a file by its real location or scopes a shared
   * sub-tree by it.
   */
  resolve(path: string): Promise<string | null>
  /** A file's bytes as a stream, optionally one closed byte range. Absent → `not-found`; a directory → `not-a-file`. */
  read(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>
  /** A whole small file, or null when absent. A directory → `not-a-file`. */
  getDoc(path: string): Promise<Uint8Array | null>
  /** Replace a whole file atomically; missing parent directories are created. */
  putDoc(path: string, bytes: Uint8Array | string, options?: WriteOptions): Promise<void>
  /** Write a file of any size from a stream; parents are created; nothing is left behind on failure. */
  write(path: string, body: ReadableStream<Uint8Array> | Uint8Array, options?: WriteOptions): Promise<{ size: number }>
  /** Remove a file, or a directory tree with `recursive`. An absent path is a no-op. */
  delete(path: string, options?: { recursive?: boolean; confined?: boolean }): Promise<void>
  /** Create a directory and any missing parents. */
  mkdir(path: string): Promise<void>
  /**
   * Add bytes to the end of a file, creating it and its parents when absent.
   * One append is one write: two appends never interleave their bytes. A
   * directory → `not-a-file`.
   */
  append(path: string, bytes: Uint8Array | string): Promise<void>
  /**
   * Open a file for reads at byte offsets: what a transcript reader that
   * pages backward from the end, or serves one span out of the middle, needs
   * beyond a single ranged `read`. Absent → `not-found`; a directory →
   * `not-a-file`. The caller closes it.
   */
  open(path: string, options?: { confined?: boolean }): Promise<OpenFile>
}

/**
 * A file opened for reads at byte offsets. The file may grow while it is
 * open (the agent appends to its transcript): `size` answers the size now,
 * and a read past the end delivers what is there.
 */
export interface OpenFile {
  /** The file's size now. */
  size(): Promise<number>
  /**
   * Up to `length` bytes from `offset`; fewer only when the file ends first.
   * `signal` is observed before every read the fill takes: one logical read
   * can take several physical ones on the filesystems where short reads
   * happen, each a round trip a caller that gave up must not pay for.
   */
  readAt(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
  /**
   * The bytes as a stream: the whole file, or from `start` to `end` (both
   * inclusive) or to the end of the file when `end` is omitted; a range past
   * the end stops at the end. The last use of the handle: the open is
   * released when the stream ends, so a caller that hands the stream on (an
   * HTTP response) has nothing left to close.
   */
  stream(range?: { start: number; end?: number }): ReadableStream<Uint8Array>
  /** Release what the open holds. Safe to call more than once, and after `stream`. */
  close(): Promise<void>
}
