/**
 * API Response Types
 *
 * Shared type definitions for API responses and frontend consumption.
 * These types represent the "flattened" format returned by API routes.
 */

import type { HealthCheckResult } from '@shared/lib/container/types'
import type { SessionUsage } from '@shared/lib/types/agent'

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
  healthWarnings?: HealthCheckResult[]
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
  lastUsage?: SessionUsage
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
  result?: unknown
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

/**
 * Compact boundary marker in API response
 */
export interface ApiCompactBoundary {
  id: string
  type: 'compact_boundary'
  summary: string
  trigger: string
  preTokens?: number
  createdAt: Date
}

/**
 * Union type for all message-like items in the API response
 */
export type ApiMessageOrBoundary = ApiMessage | ApiCompactBoundary

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

/**
 * Skill with status info (installed skill with version tracking)
 */
export interface ApiSkillWithStatus {
  name: string
  description: string
  path: string
  status: {
    type: 'local' | 'up_to_date' | 'update_available' | 'locally_modified'
    skillsetId?: string
    skillsetName?: string
    latestVersion?: string
    openPrUrl?: string
  }
}

/**
 * Skill available from a skillset but not yet installed
 */
export interface ApiDiscoverableSkill {
  skillsetId: string
  skillsetName: string
  name: string
  description: string
  version: string
  path: string
  requiredEnvVars?: Array<{ name: string; description: string }>
}

// ============================================================================
// Skillset API Types
// ============================================================================

/**
 * Skillset configuration for API responses
 */
export interface ApiSkillsetConfig {
  id: string
  url: string
  name: string
  description: string
  skillCount: number
  addedAt: string
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
// Notification API Types
// ============================================================================

/**
 * Notification response from API
 */
export interface ApiNotification {
  id: string
  type: 'session_complete' | 'session_waiting' | 'session_scheduled'
  sessionId: string
  agentSlug: string
  title: string
  body: string
  isRead: boolean
  createdAt: Date
  readAt: Date | null
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
