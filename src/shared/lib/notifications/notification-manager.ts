/**
 * Notification Manager
 *
 * Coordinates notification triggering:
 * 1. Checks notification settings (skip if disabled; auth mode defers to the
 *    per-user gates in each delivery path)
 * 2. Creates DB notification
 * 3. Builds the canonical NotificationEvent and hands it to every registered
 *    delivery channel (SSE client broadcast, Web Push, …). Viewed-session
 *    suppression is a per-channel concern: the renderer applies it for the
 *    client broadcast; Web Push currently has no presence signal and always
 *    delivers (deliberate v1 scope).
 */

import { messagePersister } from '@shared/lib/container/message-persister'
import {
  createNotification,
  getAgentAccessUserIds,
  type NotificationType,
} from '@shared/lib/services/notification-service'
import { getUserSettings } from '@shared/lib/services/user-settings-service'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getAgent } from '@shared/lib/services/agent-service'
import { getSessionMetadata } from '@shared/lib/services/session-service'
import { isHiddenAutomatedSession } from '@shared/lib/services/session-visibility'
import { captureException } from '@shared/lib/error-reporting'
import { getNotificationChannels } from './channels'
import { isNotificationTypeEnabled } from './notification-preferences'
import type { NotificationEvent } from './notification-event'
import { buildSessionCompleteBody } from './session-complete-summary'

interface SessionCompleteNotificationOptions {
  /** Final top-level assistant text, already selected by MessagePersister. */
  responseText?: string | null
  /** In-flight same-file byte-boundary snapshot for this completed turn. */
  responseTranscriptEndOffset?: Promise<number | null>
}

type NotificationBody = string | {
  fallback: string
  resolve: () => Promise<string>
}

class NotificationManager {
  // Long responses may require a model call. Keep completion notifications for
  // one session in lifecycle order even when a later short response is ready
  // first; unrelated sessions remain fully parallel.
  private readonly sessionCompleteChains = new Map<string, Promise<void>>()

  /**
   * Get the display name for an agent (name if available, otherwise slug)
   */
  private async getAgentDisplayName(agentSlug: string): Promise<string> {
    try {
      const agent = await getAgent(agentSlug)
      return agent?.frontmatter?.name || agentSlug
    } catch {
      return agentSlug
    }
  }

  /**
   * Check if notifications are enabled for a given type.
   * In non-auth mode, checks the single user's settings.
   * In auth mode, always returns true — each client checks its own user's
   * settings before showing the OS notification (see GlobalNotificationHandler).
   */
  private isNotificationTypeEnabled(type: NotificationType): boolean {
    if (isAuthMode()) {
      return true
    }

    return isNotificationTypeEnabled(getUserSettings('local').notifications, type)
  }

  /**
   * Auth mode creates one shared inbox row, but enrichment is only useful when
   * at least one ACL recipient has this notification type enabled. Delivery
   * channels still enforce each user's preference independently.
   */
  private async shouldResolveDeferredBody(
    type: NotificationType,
    agentSlug: string,
  ): Promise<boolean> {
    if (!isAuthMode()) return true

    try {
      const userIds = await getAgentAccessUserIds(agentSlug)
      return userIds.some((userId) =>
        isNotificationTypeEnabled(
          getUserSettings(userId).notifications,
          type,
        ),
      )
    } catch (error) {
      // Preference lookup failure must not suppress a potentially wanted
      // summary. Fail open, but make the unexpected token-spend path visible.
      captureException(error, {
        level: 'warning',
        tags: { area: 'notifications', op: 'deferred-body-preferences' },
        extra: { agentSlug, type },
      })
      return true
    }
  }

  /**
   * Trigger a notification if conditions are met.
   * `actions` + `actionContext` are forwarded to the OS layer where supported
   * (Electron Notification `actions` on macOS). Renderer dispatches the action
   * back into the app using `actionContext`.
   */
  private async triggerNotification(params: {
    type: NotificationType
    sessionId: string
    agentSlug: string
    title: string
    body: NotificationBody
    actions?: Array<{ text: string }>
    actionContext?: Record<string, unknown>
    extra?: Omit<Record<string, unknown>, 'type' | 'notificationType' | 'notificationId' | 'sessionId' | 'agentSlug' | 'title' | 'body' | 'actions' | 'actionContext'>
  }): Promise<void> {
    const { type, sessionId, agentSlug, title, body, actions, actionContext, extra } = params

    // A blocked automated session must become visible: session lists exclude
    // non-promoted automated sessions, so a session_waiting notification on one
    // would raise unread indicators pointing at nothing — and could never be
    // cleared. Promote first (idempotent, no-op for non-automated sessions),
    // and before the settings check: visibility isn't a notification pref.
    if (type === 'session_waiting') {
      try {
        await messagePersister.promoteAutomatedSession(sessionId, agentSlug)
      } catch (error) {
        console.error('[NotificationManager] Failed to promote automated session:', error)
      }
    }

    // Skip if notification type is disabled in settings
    if (!this.isNotificationTypeEnabled(type)) {
      return
    }

    // Completion bodies can require one summarizer call. Resolve them only
    // after preferences pass so a disabled notification never spends model
    // tokens. Other notification types keep their immediate string bodies.
    const resolvedBody = typeof body === 'string'
      ? body
      : (await this.shouldResolveDeferredBody(type, agentSlug))
          ? await body.resolve()
          : body.fallback

    // Always create DB notification (for badge/dropdown history)
    const notificationId = await createNotification({
      type,
      sessionId,
      agentSlug,
      title,
      body: resolvedBody,
    })

    // Stamp the actionContext with notificationId so the renderer dispatcher
    // can mark the DB record as read when the user clicks the OS notification
    // or one of its action buttons (otherwise the badge stays incremented
    // even after the user has clearly seen and acted on the notification).
    const stampedActionContext = actionContext
      ? { ...actionContext, notificationId }
      : undefined

    const event: NotificationEvent = {
      notificationId,
      type,
      sessionId,
      agentSlug,
      title,
      body: resolvedBody,
      navigatePath: `/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}`,
      ...(actions ? { actions } : {}),
      ...(stampedActionContext ? { actionContext: stampedActionContext } : {}),
      ...(extra ? { extra } : {}),
    }

    // Fire-and-forget per channel: delivery to one backend (a slow push POST,
    // a dead endpoint) must never block the trigger path or another channel.
    for (const channel of getNotificationChannels()) {
      void channel.deliver(event).catch((error) => {
        console.error(`[NotificationManager] ${channel.id} delivery failed:`, error)
      })
    }
  }

  /**
   * Trigger notification when a session completes successfully.
   * Suppressed for automated sessions (scheduled / webhook / chat integration) —
   * the user didn't kick those off and shouldn't be pinged when they finish.
   * `session_waiting` for the same sessions is intentionally NOT suppressed: a
   * blocked automated session still needs the user's attention.
   */
  async triggerSessionComplete(
    sessionId: string,
    agentSlug: string,
    options: SessionCompleteNotificationOptions = {},
  ): Promise<void> {
    const key = `${agentSlug}\0${sessionId}`
    const previous = this.sessionCompleteChains.get(key) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(() => this.triggerSessionCompleteNow(sessionId, agentSlug, options))
    this.sessionCompleteChains.set(key, current)

    try {
      await current
    } finally {
      if (this.sessionCompleteChains.get(key) === current) {
        this.sessionCompleteChains.delete(key)
      }
    }
  }

  private async triggerSessionCompleteNow(
    sessionId: string,
    agentSlug: string,
    options: SessionCompleteNotificationOptions,
  ): Promise<void> {
    const meta = await getSessionMetadata(agentSlug, sessionId)
    if (isHiddenAutomatedSession(meta)) {
      return
    }
    const displayName = await this.getAgentDisplayName(agentSlug)
    const fallbackBody = `${displayName} has finished running`
    await this.triggerNotification({
      type: 'session_complete',
      sessionId,
      agentSlug,
      // The old body carried the only agent identity. Keep that context after
      // replacing it with the response preview, especially on APNs / desktop.
      title: `${displayName} finished`,
      body: {
        fallback: fallbackBody,
        resolve: async () => {
          try {
            return await buildSessionCompleteBody({
              sessionId,
              agentSlug,
              responseText: options.responseText,
              responseTranscriptEndOffset:
                await options.responseTranscriptEndOffset,
              fallbackBody,
            })
          } catch (error) {
            // Body enrichment must never turn a successful session into a lost
            // notification. The helper is defensive too; this is the last guard.
            console.error('[NotificationManager] Failed to build completion body:', error)
            captureException(error, {
              tags: { area: 'notifications', op: 'session-complete-body' },
              extra: { agentSlug, sessionId },
            })
            return fallbackBody
          }
        },
      },
    })
  }

  /**
   * Trigger notification when a session is waiting for user input
   */
  async triggerSessionWaitingInput(
    sessionId: string,
    agentSlug: string,
    waitingFor: 'secret' | 'connected_account' | 'question' | 'file' | 'remote_mcp' | 'browser_input' | 'script_run' | 'computer_use' | 'capability_review_subagents' | 'capability_review_workflows',
    agentName?: string
  ): Promise<void> {
    const displayName = agentName || await this.getAgentDisplayName(agentSlug)
    let waitingMessage: string
    switch (waitingFor) {
      case 'secret':
        waitingMessage = 'needs a secret value'
        break
      case 'connected_account':
        waitingMessage = 'needs account access'
        break
      case 'question':
        waitingMessage = 'has a question for you'
        break
      case 'file':
        waitingMessage = 'needs a file from you'
        break
      case 'remote_mcp':
        waitingMessage = 'needs access to an MCP server'
        break
      case 'browser_input':
        waitingMessage = 'needs your browser input'
        break
      case 'script_run':
        waitingMessage = 'wants to run a script on your machine'
        break
      case 'computer_use':
        waitingMessage = 'wants to control your computer'
        break
      // Mirror the review card's terminology ("Run this workflow?" /
      // "Launch a subagent?") so the notification names what actually needs
      // approving.
      case 'capability_review_subagents':
        waitingMessage = 'wants to launch a subagent'
        break
      case 'capability_review_workflows':
        waitingMessage = 'wants to run a workflow'
        break
    }

    await this.triggerNotification({
      type: 'session_waiting',
      sessionId,
      agentSlug,
      title: 'Action Required',
      body: `${displayName} ${waitingMessage}`,
    })
  }

  /**
   * Trigger notification for a pending proxy / API request review.
   * Carries Approve/Deny action buttons (rendered by the OS on macOS via
   * Electron's `actions` API; ignored on Windows/Linux which fall back to
   * a click-to-focus notification).
   *
   * `kind` differentiates standard API reviews from x-agent (cross-agent)
   * reviews so the title can be appropriate for each (S7).
   */
  async triggerSessionApiReviewWaiting(
    sessionId: string,
    agentSlug: string,
    reviewId: string,
    displayText: string,
    agentName?: string,
    kind: 'api_request' | 'agent_action' = 'api_request',
  ): Promise<void> {
    const displayName = agentName || await this.getAgentDisplayName(agentSlug)
    const titleSuffix = kind === 'agent_action' ? 'Agent Action Review' : 'API Request Review'
    // Decisions are index-aligned with `actions`. Carrying them in the
    // context decouples the renderer's dispatch from button order — see
    // notification-action-schema for the contract. (Review S6.)
    const actions = [{ text: 'Approve' }, { text: 'Deny' }]
    const decisions: Array<'allow' | 'deny'> = ['allow', 'deny']
    await this.triggerNotification({
      type: 'session_waiting',
      sessionId,
      agentSlug,
      title: `${displayName} — ${titleSuffix}`,
      body: displayText,
      actions,
      actionContext: {
        kind: 'proxy_review',
        reviewId,
        agentSlug,
        sessionId,
        decisions,
      },
    })
  }

  /**
   * Trigger notification when a scheduled task starts a session
   */
  async triggerScheduledSessionStarted(
    sessionId: string,
    agentSlug: string,
    taskId: string,
    taskName?: string,
    agentName?: string
  ): Promise<void> {
    const displayName = agentName || await this.getAgentDisplayName(agentSlug)
    const taskDisplay = taskName || 'Scheduled task'

    await this.triggerNotification({
      type: 'session_scheduled',
      sessionId,
      agentSlug,
      title: 'Scheduled Task Started',
      body: `${taskDisplay} started for ${displayName}`,
      extra: { taskId },
    })
  }

  /**
   * Trigger notification when a scheduled wake resumes an existing session.
   * Reuses the session_scheduled type — a wake is a scheduled execution whose
   * target happens to be an existing session.
   */
  async triggerScheduledSessionResumed(
    sessionId: string,
    agentSlug: string,
    taskId: string,
    sessionName?: string,
    agentName?: string
  ): Promise<void> {
    const displayName = agentName || await this.getAgentDisplayName(agentSlug)
    const sessionDisplay = sessionName || 'Session'

    await this.triggerNotification({
      type: 'session_scheduled',
      sessionId,
      agentSlug,
      title: 'Session Resumed',
      body: `${sessionDisplay} resumed as scheduled for ${displayName}`,
      extra: { taskId },
    })
  }

  /**
   * Trigger notification for chat integration events (connected, disconnected, error)
   */
  async triggerChatIntegrationEvent(
    sessionId: string,
    agentSlug: string,
    integrationName: string,
    event: 'connected' | 'disconnected' | 'error',
    detail?: string,
  ): Promise<void> {
    const displayName = await this.getAgentDisplayName(agentSlug)
    let title: string
    let body: string

    switch (event) {
      case 'connected':
        title = 'Chat Integration Connected'
        body = `${integrationName} connected for ${displayName}`
        break
      case 'disconnected':
        title = 'Chat Integration Disconnected'
        body = `${integrationName} disconnected from ${displayName}`
        break
      case 'error':
        title = 'Chat Integration Error'
        body = detail
          ? `${integrationName} error on ${displayName}: ${detail}`
          : `${integrationName} encountered an error on ${displayName}`
        break
    }

    await this.triggerNotification({
      type: 'session_chat_integration',
      sessionId,
      agentSlug,
      title,
      body,
    })
  }

  /**
   * Trigger notification when a webhook event starts a session
   */
  async triggerWebhookSessionStarted(
    sessionId: string,
    agentSlug: string,
    triggerId: string,
    triggerName?: string,
    agentName?: string
  ): Promise<void> {
    const displayName = agentName || await this.getAgentDisplayName(agentSlug)
    const triggerDisplay = triggerName || 'Webhook trigger'

    await this.triggerNotification({
      type: 'session_webhook',
      sessionId,
      agentSlug,
      title: 'Webhook Trigger Fired',
      body: `${triggerDisplay} fired for ${displayName}`,
      extra: { triggerId },
    })
  }
}

// Export singleton instance
const globalForNotificationManager = globalThis as unknown as {
  notificationManager: NotificationManager | undefined
}

export const notificationManager =
  globalForNotificationManager.notificationManager ?? new NotificationManager()

if (process.env.NODE_ENV !== 'production') {
  globalForNotificationManager.notificationManager = notificationManager
}
