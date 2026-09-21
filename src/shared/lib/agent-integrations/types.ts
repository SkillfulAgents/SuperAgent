import type { IntegrationCapability } from './public'
import type { AgentActor } from '../agent-actor'
import type { SessionActivity, SessionMetadata } from '../types/agent'
import type { PendingUserInputRequest, UserInputRequestKind, UserInputRequestOutcome, UserInputRequestScope } from '../user-input/request-schema'

export type IntegrationStatus = 'active' | 'paused' | 'error' | 'disconnected'

/** Persisted installation. Existing chat rows already satisfy this contract. */
export interface AgentIntegrationRecord {
  id: string
  agentSlug: string
  provider: string
  name: string | null
  config: string
  status: IntegrationStatus
  errorMessage: string | null
  createdByUserId: string | null
  connectionId: string | null
  model: string | null
  effort: string | null
  speed: string | null
  createdAt: Date
  updatedAt: Date
  /** Optional family-specific settings. Legacy chat rows keep their existing columns. */
  settings?: unknown
}

export interface IntegrationInputEvent {
  type: 'input'
  id: string
  externalId: string
  timestamp: Date
  /** Only the family/provider interprets the external payload. */
  payload: unknown
}

export interface IntegrationResponseEvent {
  type: 'response'
  externalId: string
  requestId: string
  onAnswered?: () => void
  requestKind: 'input' | 'review'
  value: unknown
}

export type IntegrationEvent = IntegrationInputEvent | IntegrationResponseEvent | {
  type: 'hint' | 'cancel'
  externalId: string
  onInterrupted?: () => void
}

export interface IntegrationRoute {
  /** Stable logical session key within this installation. */
  externalId: string
  displayName?: string
  interactionId?: string
  /** Reply destination is distinct from the logical session key. */
  replyTarget?: Readonly<Record<string, string>>
  action: 'run' | 'reset' | 'ignore'
  notice?: string
}

/** Runtime observation is reconciled by the manager, never by a provider. */
export interface IntegrationHost {
  /** Attach/recover the mapped runtime stream before returning live session activity. */
  session(externalId: string): Promise<IntegrationSessionContext | undefined>
}

export interface IntegrationSessionRecovery {
  externalId: string
  /** When present, do not attach a replacement session for an older work item. */
  sessionId?: string
}

export interface IntegrationSessionContext {
  integration: AgentIntegrationRecord
  externalId: string
  /** Live read-only observation. Unknown means recovery has not established state. */
  readonly activity?: SessionActivity | 'unknown'
  /** Current host requests, including decisions recovered during stream attachment. */
  readonly pendingRequests?: readonly PendingUserInputRequest[]
  sessionId?: string
  interactionId?: string
  replyTarget?: Readonly<Record<string, string>>
}

export interface IntegrationInputContext extends IntegrationSessionContext {
  actor: AgentActor
}

export interface PreparedIntegrationInput {
  text: string
  systemPrompt?: string
  /** An unusable input (e.g. every attachment failed) must not start a run. */
  skip?: boolean
}

export type IntegrationOutput =
  | { type: 'runtime'; event: unknown }
  | { type: 'turn-completed'; event: unknown }
  | { type: 'turn-failed'; event: unknown }
  | { type: 'message'; text: string; inputId?: string; retryable?: boolean }
  | { type: 'request-opened'; request: PendingUserInputRequest }
  | { type: 'request-resolved'; requestId: string; kind: UserInputRequestKind; outcome: UserInputRequestOutcome; scope: UserInputRequestScope }
  | { type: 'turn-started' }
  | { type: 'session-reset' }
  | { type: 'access-approved' }
  | { type: 'request-settled' }

export interface IntegrationTool {
  name: string
  description: string
  /** JSON Schema for the tool's input; implementations also validate on execution. */
  inputSchema: Record<string, unknown>
  execute(input: unknown): Promise<unknown>
}

export interface IntegrationSessionPolicy {
  timeoutHours?: number | null
  name: string
  metadata: Partial<SessionMetadata>
}

/** Safe, serializable metadata; available without constructing a live provider. */
export interface AgentIntegrationDefinition {
  provider: string
  name: string
  family: string
  /** Server-side management policy. Unknown providers default to owner-only. */
  managementAccess?: 'user' | 'owner'
  /** Operations available to the agent. UI controls are separate. */
  capabilities: readonly string[]
  managementCapabilities?: readonly IntegrationCapability[]
  settings: readonly { key: string; label: string; type: 'boolean' }[]
  setup: { kind: string; credentialFields: readonly string[] }
}
