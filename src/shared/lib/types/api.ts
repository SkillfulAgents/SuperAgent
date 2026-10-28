/**
 * API Response Types
 *
 * Shared type definitions for API responses and frontend consumption.
 * These types represent the "flattened" format returned by API routes.
 */

import type { EffortLevel, HealthCheckResult , SpeedLevel } from '@shared/lib/container/types'
import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import type { SessionOrigin, SessionUsage } from '@shared/lib/types/agent'
import type { ApiAgentWidget } from '@shared/lib/widgets/widget-schema'
import type { IntegrationMessageDisplay } from '@shared/lib/agent-integrations/message-display-schema'
import type { AgentAvatar } from './agent-avatar'

export type { ApiAgentWidget }

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
  /** The workspace's Team Brain agent, reached from its own sidebar item rather than the agent list, and the drive it keeps. */
  teamBrain?: { volumeId: string }
  /** Older deployments omit avatar metadata; hide avatar UI when unavailable. */
  avatar?: AgentAvatar | null
  description?: string
  instructions?: string // Only included in single-agent response
  createdAt: Date
  status: 'running' | 'stopped'
  containerPort: number | null
  healthWarnings?: HealthCheckResult[]
  /** Running on a container env that a setting change replaced. A stop clears it. */
  stale?: boolean
  templateStatus?: ApiAgentTemplateStatus
  // Summary fields (included in list response)
  hasActiveSessions?: boolean
  hasSessionsAwaitingInput?: boolean
  hasUnreadNotifications?: boolean
  /** One of its sessions has an unread notification that tags the viewer. */
  hasUnreadMention?: boolean
  /**
   * The start of the newest unread notification behind the flag that wins
   * above (waiting, then mention, then any unread), on one line. Absent when
   * none of those flags has a notification to show, e.g. a session marked
   * unread by hand or a pending proxy review.
   */
  notificationPreview?: string
  sessionCount?: number
  lastActivityAt?: Date | null
  dashboards?: ApiAgentDashboard[]
  /** Home-screen widgets (see @shared/lib/widgets/widget-schema). */
  widgets?: ApiAgentWidget[]
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
  /** The template's orb, when its skillset names one. */
  avatar?: AgentAvatar
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
  /** Original source; older servers may omit it. Promotion does not change it. */
  origin?: SessionOrigin
  isActive?: boolean
  isAwaitingInput?: boolean
  hasUnreadNotifications?: boolean
  /** An unread notification that tags the viewer: drawn as an @, not a dot. */
  hasUnreadMention?: boolean
  lastUsage?: SessionUsage
  // Present when session was created by a scheduled task or webhook trigger
  scheduledTaskId?: string
  scheduledTaskName?: string
  webhookTriggerId?: string
  webhookTriggerName?: string
  // Present when another agent created this session through x-agent.
  invokedByAgentSlug?: string
  invokedByAgentName?: string
  // Automatic widget repairs also appear in the inbound invocation history.
  isWidgetRepair?: boolean
  widgetRepairSlug?: string
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
  llmProviderId?: string | null
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
  /** The runtime's task id for a Bash call run in the background, or a Monitor's watch. */
  backgroundTaskId?: string
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
  image?: string | null
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
  /**
   * Present on a message an integration delivered (Slack, Linear, …). Written
   * by the host beside the transcript, never parsed from the message text, so
   * `content.text` stays exactly what the agent received.
   */
  integration?: IntegrationMessageDisplay
  /** SDK error code when assistant message failed due to LLM provider error */
  apiError?: string
  /** Provider-authored copy for the apiError (severity, icon, markdown + CTA link). */
  errorPresentation?: ProviderErrorPresentation
  /**
   * User message delivered mid-turn (queued/steering input). It does NOT end
   * the turn it appears in — turn-boundary logic (elapsed times, running tool
   * detection) must skip it.
   */
  queued?: boolean
  /** Copied into this session by a fork. The thread draws the fork point after the last one. */
  forked?: boolean
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

// SDK codes split: NON_UPSTREAM = not an API error; PROVIDER = upstream with a generic banner; the
// rest of the enum is upstream, provider-facing only with a presentation. api.test.ts pins the enum.
export const PROVIDER_ERROR_CODES = new Set([
  'authentication_failed',
  'billing_error',
  'rate_limit',
  'invalid_request',
  'server_error',
])

export const NON_UPSTREAM_ERROR_CODES = new Set(['max_output_tokens'])

// Upstream = any code not in NON_UPSTREAM (so `unknown`, `overloaded`, … count).
// Null = the turn failed for a non-API reason (container died, tool failure).
export function isUpstreamApiErrorCode(apiErrorCode: string | null | undefined): apiErrorCode is string {
  return typeof apiErrorCode === 'string' && !NON_UPSTREAM_ERROR_CODES.has(apiErrorCode)
}

// The server only attaches a presentation when the active provider recognized
// the error, so its presence outranks a generic SDK code (the CLI tags some
// upstream denials, e.g. a 402, as `unknown`).
export function isProviderFacingError(
  apiErrorCode: string | null | undefined,
  presentation?: ProviderErrorPresentation | null,
): boolean {
  if (presentation) return true
  return typeof apiErrorCode === 'string' && PROVIDER_ERROR_CODES.has(apiErrorCode)
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
  forked?: boolean
}

/**
 * Memory recall marker in API response
 */
export interface ApiMemoryRecall {
  id: string
  type: 'memory_recall'
  memoryPaths: string[]
  createdAt: Date
  forked?: boolean
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
  forked?: boolean
}

/**
 * One batch of a Monitor watch's output, shown where the runtime delivered it
 * (see monitor-notifications.ts)
 */
export interface ApiMonitorEvent {
  id: string
  type: 'monitor_event'
  /** The watch's task id: the Monitor call's backgroundTaskId. */
  taskId: string
  description: string | null
  events: string[]
  /** Set on the batch that ended the watch (completed, failed, …). */
  status: string | null
  endReason: string | null
  createdAt: Date
  forked?: boolean
}

/**
 * Union type for all message-like items in the API response
 */
export type ApiMessageOrBoundary = ApiMessage | ApiCompactBoundary | ApiMemoryRecall | ApiInformational | ApiMonitorEvent

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
  llmProviderId?: string | null
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
  type: 'session_complete' | 'session_waiting' | 'session_scheduled' | 'session_webhook' | 'session_chat_integration' | 'session_mention'
  sessionId: string
  agentSlug: string
  title: string
  body: string
  isRead: boolean
  /** Set on a mention: it is this user's alone. */
  recipientUserId?: string | null
  /** The message a mention points at. */
  messageUuid?: string | null
  createdAt: Date
  readAt: Date | null
}
