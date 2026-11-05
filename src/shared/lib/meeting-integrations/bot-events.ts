import { getAgentIntegration } from '../services/agent-integration-service'
import { meetingProviders } from './providers'
import { isMeetingBot, meetingRoster } from './roster'
import { isTerminalMeetingStatus } from './schemas'
import type { MeetingRecord } from './store'
import { meetingTranscripts } from './transcript'

/**
 * A callback from the bot host about the room (someone joined, left, started
 * talking). Its provider reads the body and the roster is in AppState, so no
 * live connector is needed: it is applied in whichever process the host's
 * request reaches, also while the integration is paused. The route has
 * already checked the meeting's token. Returns whether the body was a
 * participant event at all.
 */
export async function receiveMeetingBotEvent(meeting: MeetingRecord, body: unknown): Promise<boolean> {
  const integration = await getAgentIntegration(meeting.integrationId)
  const provider = meetingProviders.find(candidate => candidate.definition.provider === integration?.provider)
  const event = provider ? await provider.parseBotEvent(body) : null
  if (!event) return false
  // Nothing is tracked for a call that is over. A call that ends while this
  // runs ends its roster too, and an ended roster takes no more changes, so a
  // late callback cannot bring it back.
  if (isTerminalMeetingStatus(meeting.status)) return true
  await meetingRoster.apply(meeting.id, event, meeting.botName)
  // The bot's own transcript pieces are already named; only room speech changes the speaker.
  if (event.kind === 'speech_on' && !isMeetingBot(event.participant, meeting.botName)) await meetingTranscripts.speakerStarted(meeting, event.participant.name)
  return true
}

/**
 * The call's speech as the bot's voice engine transcribed it, for the
 * meeting's transcript file: what the room said ('user') and what the bot
 * said aloud ('assistant'), with when it was heard on this host's clock. Like
 * a bot event it needs no live connector, so speech that reaches any process
 * is kept. The route has already checked the meeting's token.
 */
export function receiveMeetingSpeech(meeting: MeetingRecord, pieces: ReadonlyArray<{ role: 'user' | 'assistant'; text: string; at: number }>): void {
  if (isTerminalMeetingStatus(meeting.status)) return
  for (const { role, text, at } of pieces) meetingTranscripts.append(meeting, { text, at, speaker: role === 'assistant' ? meeting.botName : undefined })
}
