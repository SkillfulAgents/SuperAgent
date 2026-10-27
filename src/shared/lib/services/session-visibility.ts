import type { SessionMetadata, SessionOrigin } from '@shared/lib/types/agent'

/** One classification for list visibility and the provenance exposed to list consumers. */
export function sessionOrigin(meta: SessionMetadata | null | undefined): SessionOrigin {
  if (meta?.isScheduledExecution) return 'scheduled'
  if (meta?.isWebhookExecution) return 'webhook'
  if (isAgentIntegrationSession(meta)) return 'integration'
  if (meta?.invokedByAgentSlug) return 'agent'
  if (meta?.isWidgetRepair) return 'widget-repair'
  return 'user'
}

/**
 * True when a session is automated (scheduled / webhook / agent integration /
 * x-agent invocation / widget repair) and has not been promoted to
 * interactive. These sessions
 * are excluded from every user-facing session list (`excludeAutomated`), so
 * per-session signals derived elsewhere — unread-notification flags, badge
 * dots — must skip them too: a signal on a hidden session points at nothing
 * the user can see or clear, and it can never be marked read.
 */
export function isHiddenAutomatedSession(meta: SessionMetadata | null | undefined): boolean {
  return !meta?.promotedToInteractive && sessionOrigin(meta) !== 'user'
}

/** Legacy family flags remain readable so existing sessions need no migration. */
export function isAgentIntegrationSession(meta: SessionMetadata | null | undefined): boolean {
  return !!(meta?.isAgentIntegrationSession || meta?.agentIntegrationId || meta?.isChatIntegrationSession || meta?.chatIntegrationId)
}
