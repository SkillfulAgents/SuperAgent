/**
 * API Response Types
 *
 * Shared type definitions for API responses and frontend consumption.
 * These types represent the "flattened" format returned by API routes.
 */

// ============================================================================
// Agent API Types
// ============================================================================

/**
 * Agent response from API - flattened format
 */
export interface ApiAgent {
  slug: string
  name: string
  description?: string
  instructions?: string // Only included in single-agent response
  createdAt: Date
  status: 'running' | 'stopped'
  containerPort: number | null
}

// ============================================================================
// Session API Types
// ============================================================================

/**
 * Session response from API
 */
export interface ApiSession {
  id: string
  agentSlug: string
  name: string
  createdAt: Date
  lastActivityAt: Date
  messageCount: number
  isActive?: boolean
}

// ============================================================================
// Message API Types
// ============================================================================

/**
 * Tool call in API response
 */
export interface ApiToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
}

/**
 * Message content in API response
 */
export interface ApiMessageContent {
  text: string
}

/**
 * Message response from API
 */
export interface ApiMessage {
  id: string
  type: 'user' | 'assistant'
  content: ApiMessageContent
  toolCalls: ApiToolCall[]
  createdAt: Date
}

// ============================================================================
// Secret API Types
// ============================================================================

/**
 * Secret display info (without actual value)
 */
export interface ApiSecretDisplay {
  id: string // envVar is used as ID
  key: string
  envVar: string
  hasValue: boolean
}

/**
 * Full secret (used when creating/updating)
 */
export interface ApiSecret {
  key: string
  envVar: string
  value: string
}

// ============================================================================
// Skill API Types
// ============================================================================

/**
 * Skill info from agent's .claude/skills directory
 */
export interface ApiSkill {
  path: string
  name: string
  description: string
}

// ============================================================================
// Scheduled Task API Types
// ============================================================================

/**
 * Scheduled task response from API
 */
export interface ApiScheduledTask {
  id: string
  agentSlug: string
  scheduleType: 'at' | 'cron'
  scheduleExpression: string
  prompt: string
  name: string | null
  status: 'pending' | 'executed' | 'cancelled' | 'failed'
  nextExecutionAt: Date
  lastExecutedAt: Date | null
  isRecurring: boolean
  executionCount: number
  lastSessionId: string | null
  createdBySessionId: string | null
  createdAt: Date
  cancelledAt: Date | null
}

// ============================================================================
// Connected Account API Types
// ============================================================================

/**
 * Provider info
 */
export interface ApiProvider {
  slug: string
  displayName: string
  icon?: string
}

/**
 * Connected account response
 */
export interface ApiConnectedAccount {
  id: string
  composioConnectionId: string
  toolkitSlug: string
  displayName: string
  status: 'active' | 'revoked' | 'expired'
  createdAt: Date
  updatedAt: Date
  provider?: ApiProvider
  // Only present when fetched for a specific agent
  mappingId?: string
  mappedAt?: Date
}
