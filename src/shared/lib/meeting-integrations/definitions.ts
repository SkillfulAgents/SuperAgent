import type { AgentIntegration } from '../agent-integrations/agent-integration'
import type { AgentIntegrationRecord, IntegrationRoute, IntegrationSessionContext, IntegrationSessionPolicy } from '../agent-integrations/types'
import type { LiveConversationSetting } from '../voice/live-types'
import { resolveInternetAppBaseUrl } from '../agent-integrations/app-link'
import { captureException } from '../error-reporting'
import type { MeetingBotHost } from './bot-host'
import { meetingLiveSetting } from './prompts'
import type { MeetingIntegrationSettings } from './schemas'
import { meetingRoster } from './roster'
import { getMeeting, listOpenMeetings, transitionMeeting } from './store'

export const MEETING_FAMILY = 'meeting' as const

/** Operations the family exposes; providers declare them all since the family implements them. */
export const MEETING_CAPABILITIES = ['join_meeting', 'leave_meeting', 'list_meetings', 'send_meeting_chat'] as const

export const MEETING_AGENT_INSTRUCTIONS = 'A meeting integration lets you attend video calls (Zoom, Google Meet, Microsoft Teams). A person sends you into a call from the integration page in the app with an invite link, an optional brief and a mode: "voice" speaks when addressed, "silent" answers in the call chat and on your tile without speaking, "listen" gives the call nothing and works for the person who sent you, who reads your notes in the app. Each call becomes its own session in which what people say reaches you as messages, and what you write is delivered according to the mode. Joining, leaving and posting into a call are not tools you can call yourself; if asked to join a meeting, say that it is started from the integration page.'

/** Access and session shape, available without a live connection (startup, reconnect, outbound). */
export const meetingPolicy: Pick<AgentIntegration, 'isAllowed' | 'sessionPolicy'> = {
  async isAllowed(context: IntegrationSessionContext): Promise<boolean> {
    return context.integration.status === 'active' || context.integration.status === 'error'
  },
  sessionPolicy(integration: AgentIntegrationRecord, route: Partial<IntegrationRoute>): IntegrationSessionPolicy {
    return {
      // One meeting is one session for as long as it lasts; it never rotates on a timer.
      timeoutHours: null,
      name: route.displayName ?? `${integration.name ?? 'Meeting'}`,
      metadata: {},
    }
  },
}

/**
 * A meeting bot is a browser on someone else's infrastructure loading this
 * app, so the deployment needs an address the internet can reach; and the
 * provider needs a way to its bot service. Both are deployment facts, decided
 * here once so the picker, setup and the join tool agree.
 */
export function meetingAvailability(hasBotService: boolean): boolean {
  // A public https address (HOST_PUBLIC_URL) for the bot's browser to load the page,
  // and a Platform connection (or RECALL_API_KEY) to run the bot. The voice provider
  // is not a condition: a provider without a Live engine runs the chained engine in
  // the call, which hears everything as addressed to the agent and says more than
  // the room wants, but it works.
  return resolveInternetAppBaseUrl() !== null && hasBotService
}

/**
 * The room a meeting session's voice conversation takes place in, for the
 * Live host. The provider reads its own configuration for the installation's
 * standing instructions, so a change there reaches the next minted session.
 */
export async function meetingLiveSettingFor(externalId: string, settings: Pick<MeetingIntegrationSettings, 'instructions' | 'voice'>): Promise<LiveConversationSetting | undefined> {
  const meeting = await getMeeting(externalId)
  if (!meeting) return undefined
  return meetingLiveSetting(meeting, meetingRoster.get(meeting.id).participants, settings)
}

/**
 * Send every bot of an installation home, for teardown paths that have no
 * connector (the installation is being deleted). Best effort per meeting: a
 * bot the host no longer knows is already gone.
 */
export async function leaveOpenMeetings(integrationId: string, host: MeetingBotHost, reason = 'The integration was removed'): Promise<void> {
  for (const meeting of await listOpenMeetings(integrationId)) {
    try {
      if (meeting.botId) await host.leaveCall(meeting.botId)
      await transitionMeeting(meeting.id, 'ended', reason)
      meetingRoster.clear(meeting.id)
    } catch (error) {
      captureException(error, { tags: { component: 'meeting-integration', operation: 'leave-on-cleanup' }, extra: { meetingId: meeting.id } })
    }
  }
}
