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
import { createLocalHostPort, type ComputerUseCaller, type HostPort, type SessionNotification } from '@shared/lib/agent-actor/host-port'
import { globalFeed, type GlobalFeedEvent } from '@shared/lib/notifications/global-feed'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'

// The mock E2E runtime drives no real machine: computer-use commands succeed
// without running, and no macOS permission is ever missing.
const isE2EMock = () => process.env.E2E_MOCK === 'true'

const computerUse = () => import('@shared/lib/computer-use/executor')

/** The app a mock E2E call names, as the machine would place it: its app or other target, if it names one. */
async function mockTargetApp(method: string, params: Record<string, unknown>): Promise<string | undefined> {
  const [{ commandLineOf }, { callTargets }] = await Promise.all([
    import('@shared/lib/computer-use/command-line'),
    import('@shared/lib/computer-use/commands'),
  ])
  try {
    const line = commandLineOf(method, params)
    const targets = callTargets(line.method, line.params)
    return targets.app ?? targets.system
  } catch {
    return undefined
  }
}

/** The caller as the executor draws its cursor: labelled with the agent's name, in its avatar colour. */
async function computerUseCaller(caller: ComputerUseCaller): Promise<import('@shared/lib/computer-use/executor').ComputerUseCaller> {
  const [{ getAgentRecord }, { agentAvatarAccent }] = await Promise.all([
    import('@shared/lib/services/agent-service'),
    import('@shared/lib/types/agent-avatar-orbs'),
  ])
  const record = await getAgentRecord(caller.agentSlug).catch(() => null)
  return {
    ...caller,
    label: record?.name ?? caller.agentSlug,
    ...(record?.avatar && { accent: agentAvatarAccent(record.avatar.color), avatar: record.avatar }),
  }
}

function notify(notification: SessionNotification): Promise<void> {
  switch (notification.kind) {
    case 'session_complete':
      return notificationManager.triggerSessionComplete(notification.sessionId, notification.agentSlug, {
        responseText: notification.responseText,
        responseTranscriptEndOffset: notification.responseTranscriptEndOffset,
        taggedUserIds: notification.taggedUserIds,
      })
    case 'message_mentions':
      return notificationManager.triggerAgentMentions(notification)
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
function feedEvent(event: GlobalFeedEvent, announceSessionStart?: SessionStartAnnouncer): Promise<void> {
  globalFeed.publish(event)
  return hostWorkFor(event, announceSessionStart)
}

type SessionStartAnnouncer = (agentSlug: string, sessionId: string) => Promise<void>

/** Loaded on first use, as the tools are: both services reach back to the agent registry. */
async function hostWorkFor(event: GlobalFeedEvent, announceSessionStart?: SessionStartAnnouncer): Promise<void> {
  // A session settled: the agent's stale and opted-in widgets re-run.
  if (event.type === 'session_idle' && typeof event.agentSlug === 'string') {
    const { widgetRefreshService } = await import('@shared/lib/services/widget-refresh-service')
    widgetRefreshService.afterSessionSettled(event.agentSlug)
  }
  // A session started a turn: the chat it belongs to, if any, follows it.
  if (event.type === 'session_active' && typeof event.agentSlug === 'string' && typeof event.sessionId === 'string') {
    if (announceSessionStart) return announceSessionStart(event.agentSlug, event.sessionId)
    const { agentIntegrationManager } = await import('@shared/lib/agent-integrations/agent-integration-manager')
    await agentIntegrationManager.sessionStarted(event.agentSlug, event.sessionId)
  }
}

/**
 * The host as the agents in this process reach it. `announceSessionStart` is where a session's
 * start is announced, so the chat it belongs to follows it. Omitted, as on desktop and the Node
 * server, it is the integration manager of this process; a deployment that keeps the chat
 * connections in another process passes what reaches them there.
 */
export function createProcessHostPort(options: { announceSessionStart?: SessionStartAnnouncer } = {}): HostPort {
  return createLocalHostPort({
    calls: {
      hostTool: async (request) => (await import('./tools')).runHostTool(request),
      computerUse: async ({ method, params, caller, startBy, app }) => {
        if (!isE2EMock()) return (await computerUse()).executeComputerUseCommand(method, params, await computerUseCaller(caller), { startBy, app })
        const acted = app ?? (await mockTargetApp(method, params))
        return { output: `[mock] ${method} executed successfully`, ...(acted !== undefined && { app: acted }) }
      },
      computerUsePermissions: async (needs) => (isE2EMock() ? null : (await computerUse()).checkComputerUsePermissions(needs)),
      computerUseTargetApp: async ({ method, params }) =>
        isE2EMock()
          ? mockTargetApp(method, params)
          : (await computerUse()).placeComputerUseCall(method, params),
      computerUseAppIcon: async ({ app }) => (await import('@shared/lib/computer-use/app-icon')).getAppIconBase64(app),
      hostScript: async ({ script, scriptType }) => (await import('./script')).runHostScript(script, scriptType),
      loginRequest: async (request) => (await import('@shared/lib/browser-vault/login-host')).decideLoginRequest(request),
    },
    events: {
      global: (event) => feedEvent(event, options.announceSessionStart),
      notification: notify,
      analytics: ({ event, properties }) => trackServerEvent(event, properties),
      computerUseTurnEnded: async ({ sessionId }) => {
        if (!isE2EMock()) (await computerUse()).endComputerUseTurn(sessionId)
      },
    },
  })
}

export const localHostPort = createProcessHostPort()
