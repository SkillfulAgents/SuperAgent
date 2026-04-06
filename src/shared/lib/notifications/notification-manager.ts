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
   * Trigger a notification if conditions are met
   */
  private async triggerNotification(params: {
    type: NotificationType
    sessionId: string
    agentSlug: string
    title: string
    body: string
  }): Promise<void> {
    const { type, sessionId, agentSlug, title, body } = params

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
    })
  }

  /**
   * Trigger notification when a session completes successfully
   */
  async triggerSessionComplete(
    sessionId: string,
    agentSlug: string,
    agentName?: string
  ): Promise<void> {
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
   * Trigger notification when a scheduled task starts a session
   */
  async triggerScheduledSessionStarted(
    sessionId: string,
    agentSlug: string,
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
    })
  }

  /**
   * Trigger notification when a webhook event starts a session
   */
  async triggerWebhookSessionStarted(
    sessionId: string,
    agentSlug: string,
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
