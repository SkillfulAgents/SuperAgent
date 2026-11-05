import { getAgentIntegration } from '../services/agent-integration-service'
import { meetingProviders } from './providers'
import { isMeetingBot, meetingRoster } from './roster'
import { isTerminalMeetingStatus } from './schemas'
import { meetingScreenshots } from './screenshots'
import type { MeetingRecord } from './store'
import { meetingSpeakerStarted } from './transcript-speakers'

async function providerOf(meeting: MeetingRecord) {
  const integration = await getAgentIntegration(meeting.integrationId)
  return meetingProviders.find(candidate => candidate.definition.provider === integration?.provider)
}

/**
 * A callback from the bot host about the room (someone joined, left, started
 * talking). Its provider reads the body and the roster is in AppState, so no
 * live connector is needed: it is applied in whichever process the host's
 * request reaches, also while the integration is paused. The route has
 * already checked the meeting's token. Returns whether the body was a
 * participant event at all.
 */
export async function receiveMeetingBotEvent(meeting: MeetingRecord, body: unknown): Promise<boolean> {
  const provider = await providerOf(meeting)
  const event = provider ? await provider.parseBotEvent(body) : null
  if (!event) return false
  // Nothing is tracked for a call that is over. A call that ends while this
  // runs ends its roster too, and an ended roster takes no more changes, so a
  // late callback cannot bring it back.
  if (isTerminalMeetingStatus(meeting.status)) return true
  await meetingRoster.apply(meeting.id, event, meeting.botName)
  // The bot's own transcript pieces are already named; only room speech changes the speaker.
  if (event.kind === 'speech_on' && !isMeetingBot(event.participant, meeting.botName)) await meetingSpeakerStarted(meeting.id, event.participant.name)
  return true
}

/**
 * Reads one meeting's frames-socket messages. Its provider reads each message
 * and screenshots are files in the agent's workspace, so, like a bot event,
 * no live connector is needed. The provider is looked up once per socket,
 * since frames arrive several times a second. Camera frames are dropped by the
 * provider and never stored. Null when the provider's host sends no frames.
 */
export async function meetingScreenFrameReceiver(meeting: MeetingRecord): Promise<((message: unknown) => Promise<void>) | null> {
  const provider = await providerOf(meeting)
  if (!provider?.parseScreenFrame) return null
  return async (message) => {
    const frame = await provider.parseScreenFrame!(message)
    if (frame) meetingScreenshots.offer(meeting, frame)
  }
}
