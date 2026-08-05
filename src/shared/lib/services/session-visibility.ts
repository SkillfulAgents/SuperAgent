import type { SessionMetadata } from '@shared/lib/types/agent'

/**
 * True when a session is automated (scheduled / webhook / chat integration)
 * and has not been promoted to interactive. These sessions are excluded from
 * every user-facing session list (`excludeAutomated`), so per-session signals
 * derived elsewhere — unread-notification flags, badge dots — must skip them
 * too: a signal on a hidden session points at nothing the user can see or
 * clear, and it can never be marked read.
 */
export function isHiddenAutomatedSession(meta: SessionMetadata | null | undefined): boolean {
  if (!meta || meta.promotedToInteractive) return false
  return !!(meta.isScheduledExecution || meta.isWebhookExecution || meta.isChatIntegrationSession)
}
