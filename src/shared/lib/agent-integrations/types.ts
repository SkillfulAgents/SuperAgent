import type { AgentActor } from '../agent-actor'
import type { SessionMetadata } from '../types/agent'
import type { PendingUserInputRequest } from '../user-input/request-schema'

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

export interface IntegrationSessionContext {
  integration: AgentIntegrationRecord
  externalId: string
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
  | { type: 'request'; request: PendingUserInputRequest }
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
  capabilities: readonly string[]
  settings: readonly { key: string; label: string; type: 'boolean' }[]
  setup: { kind: string; credentialFields: readonly string[] }
}
