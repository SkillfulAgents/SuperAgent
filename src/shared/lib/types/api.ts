/**
 * API Response Types
 *
 * Shared type definitions for API responses and frontend consumption.
 * These types represent the "flattened" format returned by API routes.
 */

import type { EffortLevel, HealthCheckResult , SpeedLevel } from '@shared/lib/container/types'
import type { SessionUsage } from '@shared/lib/types/agent'

// ============================================================================
// Agent API Types
// ============================================================================

/**
 * Agent response from API - flattened format
 */
export interface ApiAgent {
  /** Canonical opaque id — folder name, DB key, URL resolution key. Never changes. */
  slug: string
  /** Decorative `{slug(name)}-{id}` projection for URLs/links; recomputed from the current name. */
  displaySlug: string
  name: string
  description?: string
  instructions?: string // Only included in single-agent response
  createdAt: Date
  status: 'running' | 'stopped'
  containerPort: number | null
  healthWarnings?: HealthCheckResult[]
  templateStatus?: ApiAgentTemplateStatus
  // Summary fields (included in list response)
  hasActiveSessions?: boolean
  hasSessionsAwaitingInput?: boolean
  hasUnreadNotifications?: boolean
  sessionCount?: number
  lastActivityAt?: Date | null
  dashboards?: ApiAgentDashboard[]
  /** Opt-in expansion from GET /api/agents?include_latest_visible_session_tail=true. */
  latestVisibleSession?: ApiLatestVisibleSession | null
  /** Attention on visible sessions other than latestVisibleSession. Null means unavailable. */
  attentionOutsideLatest?: ApiAttentionOutsideLatest | null
}

/** Response returned when an agent template has been installed or imported. */
export interface ApiAgentTemplateInstallResult extends ApiAgent {
  hasOnboarding?: boolean
  /** Optional root PROMPT.md contents to prefill on the new agent's home page. */
  templatePrompt?: string
  /** Optional `first_prompt` from the onboarding skill frontmatter. */
  onboardingFirstPrompt?: string
}

export interface ApiAgentDashboard {
  slug: string
  name: string
  hasScreenshot?: boolean
}

export interface ApiLatestVisibleSession {
  session: ApiSession
  messageTail: ApiTranscriptPage
}

export interface ApiAttentionOutsideLatest {
  hasUnreadNotification: boolean
  hasPendingInput: boolean
}

export interface ApiTranscriptPage {
  messages: ApiMessageOrBoundary[]
  nextCursor: string | null
}

/**
 * Shared status shape used by both skill and agent template tracking.
 */
export interface ApiItemStatus {
  type: 'local' | 'up_to_date' | 'update_available' | 'locally_modified'
  skillsetId?: string
  skillsetName?: string
  sourceLabel?: string
  publishable?: boolean
  latestVersion?: string
  openPrUrl?: string
}

/** @deprecated Use ApiItemStatus instead */
export type ApiAgentTemplateStatus = ApiItemStatus

/**
 * Agent available from a skillset but not yet installed
 */
export interface ApiDiscoverableAgent {
  skillsetId: string
  skillsetName: string
  name: string
  description: string
  version: string
  path: string
  /** Long-form markdown for the details page. */
  details?: string
  /** Marketplace category, e.g. "Marketing", "Customer Success". */
  category?: string
  /** kebab-case lucide icon name, e.g. "badge-dollar-sign". */
  icon?: string
  tags?: string[]
  /** Services the template connects to; `slug` matches the service-icon set. */
  worksWith?: { type: string; slug: string }[]
  developer?: { name: string; url?: string }
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
  isAwaitingInput?: boolean
  hasUnreadNotifications?: boolean
  lastUsage?: SessionUsage
  // Present when session was created by a scheduled task or webhook trigger
  scheduledTaskId?: string
  scheduledTaskName?: string
  webhookTriggerId?: string
  webhookTriggerName?: string
  // Present when another agent created this session through x-agent.
  invokedByAgentSlug?: string
  invokedByAgentName?: string
  // Present when this session was forked from another. Name resolves from the
  // parent's metadata on the single-session GET; undefined when the parent is gone.
  forkedFromSessionId?: string
  forkedFromSessionName?: string
  // Last effort level used on this session (seeds the composer selector)
  effort?: EffortLevel
  // Last processing speed used on this session (seeds the composer selector)
  speed?: SpeedLevel
  // Last model used on this session (seeds the composer selector)
  model?: string
  // Present when the session has a pending scheduled wake (long sleep):
  // it will auto-resume at pendingWakeAt with pendingWakeNote echoed back.
  pendingWakeAt?: string
  pendingWakeTaskId?: string
  pendingWakeNote?: string
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
  subagent?: {
    agentId: string
    status: string
    totalDurationMs?: number
    totalTokens?: number
    totalToolUseCount?: number
  }
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
export interface ApiMessageSender {
  id: string
  name: string
  email: string
}

export interface ApiMessage {
  id: string
  type: 'user' | 'assistant'
  content: ApiMessageContent
  toolCalls: ApiToolCall[]
  createdAt: Date
  sender?: ApiMessageSender
  /** SDK error code when assistant message failed due to LLM provider error */
  apiError?: string
  /**
   * User message delivered mid-turn (queued/steering input). It does NOT end
   * the turn it appears in — turn-boundary logic (elapsed times, running tool
   * detection) must skip it.
   */
  queued?: boolean
  /**
   * Summarized extended-thinking blocks persisted in the session transcript,
   * in order. Absent when the turn had no thinking or the transcript predates
   * thinking-text persistence. `durationMs` is derived from transcript entry
   * timestamps and absent when underivable.
   */
  thinking?: Array<{ id?: string; text: string; durationMs?: number }>
  /** Per-model-response token usage preserved from the session transcript. */
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
  }
}

/**
 * SDK error codes that indicate an external LLM provider issue
 * (as opposed to application-level errors like max_output_tokens).
 */
export const PROVIDER_ERROR_CODES = new Set([
  'authentication_failed',
  'billing_error',
  'rate_limit',
  'invalid_request',
  'server_error',
])

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
 * Memory recall marker in API response
 */
export interface ApiMemoryRecall {
  id: string
  type: 'memory_recall'
  memoryPaths: string[]
  createdAt: Date
}

/**
 * Host-persisted informational banner in API response (e.g. a hook blocked a
 * prompt before it reached the model)
 */
export interface ApiInformational {
  id: string
  type: 'informational'
  content: string
  level?: string
  createdAt: Date
}

/**
 * Union type for all message-like items in the API response
 */
export type ApiMessageOrBoundary = ApiMessage | ApiCompactBoundary | ApiMemoryRecall | ApiInformational

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
  status: ApiItemStatus
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
}

/**
 * File entry in a skill's directory tree
 */
export interface ApiSkillFileEntry {
  path: string
  type: 'file' | 'directory'
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
  agentCount: number
  addedAt: string
  provider?: 'github' | 'platform' | 'public'
  badgeLabel?: string
  showUrl: boolean
  publishMode: 'pull_request' | 'hosted_submit' | 'none'
  credential?: {
    type: 'token'
    tokenPreview: string
  }
  error?: string
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
  status: 'pending' | 'paused' | 'executed' | 'cancelled' | 'failed'
  nextExecutionAt: Date
  lastExecutedAt: Date | null
  isRecurring: boolean
  executionCount: number
  lastSessionId: string | null
  createdBySessionId: string | null
  timezone: string | null
  model: string | null
  effort: string | null
  speed: string | null
  createdAt: Date
  cancelledAt: Date | null
  pausedAt: Date | null
}

// ============================================================================
// Notification API Types
// ============================================================================

/**
 * Notification response from API
 */
export interface ApiNotification {
  id: string
  type: 'session_complete' | 'session_waiting' | 'session_scheduled' | 'session_webhook' | 'session_chat_integration'
  sessionId: string
  agentSlug: string
  title: string
  body: string
  isRead: boolean
  createdAt: Date
  readAt: Date | null
}
