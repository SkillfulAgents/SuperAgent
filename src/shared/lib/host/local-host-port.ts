/**
 * The host as the agents in this process reach it: every `host.call` and
 * `host.send` an actor makes, bound to its handler here.
 *
 * The host tools, the computer-use daemon and the script runner load on
 * first use: the agent registry wires this port into every actor, and a
 * static import would put all of their services and child_process in the
 * import graph of anything that touches an agent. Notifications, analytics
 * and the global feed are handed over synchronously, as they always were.
 */
import { createLocalHostPort, type SessionNotification } from '@shared/lib/agent-actor/host-port'
import { globalFeed, type GlobalFeedEvent } from '@shared/lib/notifications/global-feed'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'

// The mock E2E runtime drives no real machine: computer-use commands succeed
// without running, and no macOS permission is ever missing.
const isE2EMock = () => process.env.E2E_MOCK === 'true'

const computerUse = () => import('@shared/lib/computer-use/executor')

function notify(notification: SessionNotification): Promise<void> {
  switch (notification.kind) {
    case 'session_complete':
      return notificationManager.triggerSessionComplete(notification.sessionId, notification.agentSlug, {
        responseText: notification.responseText,
        responseTranscriptEndOffset: notification.responseTranscriptEndOffset,
      })
    case 'session_waiting_input':
      return notificationManager.triggerSessionWaitingInput(notification.sessionId, notification.agentSlug, notification.request)
    case 'api_review_waiting':
      return notificationManager.triggerSessionApiReviewWaiting(
        notification.sessionId,
        notification.agentSlug,
        notification.reviewId,
        notification.displayText,
        undefined,
        notification.reviewKind,
      )
    case 'message_discarded':
      return notificationManager.withdrawSessionMentions(notification.messageUuid)
  }
}

/**
 * An actor's event for the global feed. Clients get it from the feed, as a
 * hint that may never reach them. Work the host must do because of it is
 * started here, directly, so it never waits on a hint reaching a listener.
 */
function feedEvent(event: GlobalFeedEvent): Promise<void> {
  globalFeed.publish(event)
  return hostWorkFor(event)
}

/** Loaded on first use, as the tools are: both services reach back to the agent registry. */
async function hostWorkFor(event: GlobalFeedEvent): Promise<void> {
  // A session settled: the agent's stale and opted-in widgets re-run.
  if (event.type === 'session_idle' && typeof event.agentSlug === 'string') {
    const { widgetRefreshService } = await import('@shared/lib/services/widget-refresh-service')
    widgetRefreshService.afterSessionSettled(event.agentSlug)
  }
  // A review opened outside any session: a chat following the agent shows its card.
  if (event.type === 'user_request_created') {
    const { agentIntegrationManager } = await import('@shared/lib/agent-integrations/agent-integration-manager')
    await agentIntegrationManager.handleRequestCreated(event)
  }
}

export const localHostPort = createLocalHostPort({
  calls: {
    hostTool: async (request) => (await import('./tools')).runHostTool(request),
    computerUse: async ({ method, params }) =>
      isE2EMock() ? `[mock] ${method} executed successfully` : (await computerUse()).executeComputerUseCommand(method, params),
    computerUsePermissions: async () => (isE2EMock() ? null : (await computerUse()).checkACPermissions()),
    computerUseWindowApp: async ({ ref }) => (await computerUse()).resolveAppFromWindowRef(ref),
    computerUseAppIcon: async ({ app }) => (await import('@shared/lib/computer-use/app-icon')).getAppIconBase64(app),
    hostScript: async ({ script, scriptType }) => (await import('./script')).runHostScript(script, scriptType),
    loginRequest: async (request) => (await import('@shared/lib/browser-vault/login-host')).decideLoginRequest(request),
  },
  events: {
    global: feedEvent,
    notification: notify,
    analytics: ({ event, properties }) => trackServerEvent(event, properties),
  },
})
