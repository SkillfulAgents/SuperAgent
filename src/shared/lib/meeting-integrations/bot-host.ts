import type { MeetingPlatform } from './meeting-url'
import type { MeetingParticipantEvent, MeetingStatus } from './schemas'

/** What the family asks a provider for; the family never sees provider payloads. */
export interface MeetingBotJoinRequest {
  meetingUrl: string
  platform: MeetingPlatform
  botName: string
  /** The page the bot presents as its camera and runs the voice loop in. */
  participantPageUrl: string
  /** Where the host may POST in-call events (who joined, left, is speaking), if it can. */
  eventsUrl?: string
}

export interface MeetingBotStatus {
  status: MeetingStatus
  /** Provider wording for the UI (waiting-room reason, failure code). */
  detail?: string
}

/** A recording the host kept of the call, fetched on demand because its link expires. */
export interface MeetingRecordingLink {
  url: string
  /** When the link stops working; the host hands out a fresh one on the next request. */
  linkExpiresAt: number | null
}

/**
 * A provider's bot service: it puts a browser into a call and reports where
 * the bot is. One host serves one installation; credentials and attribution
 * are the host's concern.
 */
export interface MeetingBotHost {
  createBot(request: MeetingBotJoinRequest): Promise<{ botId: string }>
  getBotStatus(botId: string): Promise<MeetingBotStatus>
  leaveCall(botId: string): Promise<void>
  sendChatMessage(botId: string, message: string): Promise<void>
  /** Reduce an in-call callback body to a participant event, or null when it is something else. */
  parseEvent(body: unknown): MeetingParticipantEvent | null
  /** A link to the call's recording while the host still keeps it; null once gone or not yet ready. */
  recordingLink?(botId: string): Promise<MeetingRecordingLink | null>
}
