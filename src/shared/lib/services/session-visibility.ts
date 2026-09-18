import type { SessionMetadata } from '@shared/lib/types/agent'

/**
 * True while nobody is watching the session: a cron / trigger / widget-repair
 * run that has not been promoted. This is the one flag behind the notify_user
 * tool and the unattended prompt section. Chat Integration and x-agent target
 * sessions are never noninteractive — someone (the chat user, the calling
 * agent) reads their output.
 */
export function isNoninteractiveSession(meta: SessionMetadata | null | undefined): boolean {
  if (!meta) return false
  if (typeof meta.noninteractive === 'boolean') return meta.noninteractive
  // Rows written before `noninteractive` existed.
  if (meta.promotedToInteractive) return false
  return !!(meta.isScheduledExecution || meta.isWebhookExecution || meta.isWidgetRepair)
}

/**
 * True when a session is excluded from every user-facing session list
 * (`excludeAutomated`): noninteractive sessions, plus chat-integration and
 * x-agent target sessions until a request promotes them. Per-session signals
 * derived elsewhere — unread-notification flags, badge dots — must skip these
 * too: a signal on a hidden session points at nothing the user can see or
 * clear, and it can never be marked read.
 */
export function isHiddenAutomatedSession(meta: SessionMetadata | null | undefined): boolean {
  if (!meta) return false
  if (isNoninteractiveSession(meta)) return true
  if (meta.promotedToInteractive) return false
  return !!(meta.isChatIntegrationSession || meta.invokedByAgentSlug)
}
