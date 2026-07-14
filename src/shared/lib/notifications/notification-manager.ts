/**
 * Notification Manager
 *
 * Coordinates notification triggering:
 * 1. Checks if session is currently being viewed (skip if so)
 * 2. Checks notification settings (skip if disabled)
 * 3. Creates DB notification
 * 4. Broadcasts OS notification event via SSE
 */

import { messagePersister } from '@shared/lib/container/message-persister'
import {
  createNotification,
  type NotificationType,
} from '@shared/lib/services/notification-service'
import { getUserSettings } from '@shared/lib/services/user-settings-service'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getAgent } from '@shared/lib/services/agent-service'
import { getSessionMetadata } from '@shared/lib/services/session-service'

class NotificationManager {
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

    const settings = getUserSettings('local')
    const notificationSettings = settings.notifications

    // Check global toggle first
    if (!notificationSettings.enabled) {
      return false
    }

    // Check per-type toggle
    switch (type) {
      case 'session_complete':
        return notificationSettings.sessionComplete !== false
      case 'session_waiting':
        return notificationSettings.sessionWaiting !== false
      case 'session_scheduled':
        return notificationSettings.sessionScheduled !== false
      default:
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
    body: string
    actions?: Array<{ text: string }>
    actionContext?: Record<string, unknown>
    extra?: Omit<Record<string, unknown>, 'type' | 'notificationType' | 'notificationId' | 'sessionId' | 'agentSlug' | 'title' | 'body' | 'actions' | 'actionContext'>
  }): Promise<void> {
    const { type, sessionId, agentSlug, title, body, actions, actionContext, extra } = params

    // Skip if notification type is disabled in settings
    if (!this.isNotificationTypeEnabled(type)) {
      return
    }

    // Always create DB notification (for badge/dropdown history)
    const notificationId = await createNotification({
      type,
      sessionId,
      agentSlug,
      title,
      body,
    })

    // Stamp the actionContext with notificationId so the renderer dispatcher
    // can mark the DB record as read when the user clicks the OS notification
    // or one of its action buttons (otherwise the badge stays incremented
    // even after the user has clearly seen and acted on the notification).
    const stampedActionContext = actionContext
      ? { ...actionContext, notificationId }
      : undefined

    // Broadcast OS notification event to all connected clients
    // Frontend will decide whether to show based on tab visibility and selected session
    messagePersister.broadcastGlobal({
      type: 'os_notification',
      notificationId,
      notificationType: type,
      sessionId,
      agentSlug,
      title,
      body,
      ...(actions ? { actions } : {}),
      ...(stampedActionContext ? { actionContext: stampedActionContext } : {}),
      ...extra,
    })
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
    agentName?: string
  ): Promise<void> {
    const meta = await getSessionMetadata(agentSlug, sessionId)
    if (
      !meta?.promotedToInteractive &&
      (meta?.isScheduledExecution || meta?.isWebhookExecution || meta?.isChatIntegrationSession)
    ) {
      return
    }
    const displayName = agentName || await this.getAgentDisplayName(agentSlug)
    await this.triggerNotification({
      type: 'session_complete',
      sessionId,
      agentSlug,
      title: 'Session Complete',
      body: `${displayName} has finished running`,
    })
  }

  /**
   * Trigger notification when a session is waiting for user input
   */
  async triggerSessionWaitingInput(
    sessionId: string,
    agentSlug: string,
    waitingFor: 'secret' | 'connected_account' | 'question' | 'file' | 'remote_mcp' | 'browser_input' | 'script_run' | 'computer_use',
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
