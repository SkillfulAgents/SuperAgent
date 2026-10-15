import { z } from 'zod'
import { meetingPlatformSchema } from './meeting-url'

/**
 * One meeting the agent was asked to attend, from the request until the bot
 * has left. Phases are provider-neutral; a host maps its own codes onto them.
 */
export const MEETING_STATUSES = ['requested', 'joining', 'waiting_room', 'in_call', 'ended', 'failed'] as const
export const meetingStatusSchema = z.enum(MEETING_STATUSES)
export type MeetingStatus = z.infer<typeof meetingStatusSchema>
export const TERMINAL_MEETING_STATUSES: readonly MeetingStatus[] = ['ended', 'failed']
export function isTerminalMeetingStatus(status: MeetingStatus): boolean { return TERMINAL_MEETING_STATUSES.includes(status) }

/**
 * How long the bot service keeps a call's audio after the call. Long enough
 * for whoever ran the meeting to listen back from the integration page; the
 * bot says so in the call's chat when it joins.
 */
export const MEETING_RECORDING_RETENTION_HOURS = 7 * 24

/**
 * Standing instructions an installation carries into every meeting its agent
 * joins, alongside the brief given for one call. Bounded so the voice model's
 * room description stays within its prompt budget.
 */
export const MEETING_INSTRUCTIONS_MAX_CHARS = 2000

/**
 * How the agent takes part in a call. `voice` speaks when addressed; `silent`
 * hears the room but answers in the call's chat and on its tile; `listen`
 * gives the room nothing at all and works for the person who brought it,
 * who reads the output in the app.
 */
export const MEETING_MODES = ['voice', 'silent', 'listen'] as const
export const meetingModeSchema = z.enum(MEETING_MODES)
export type MeetingMode = z.infer<typeof meetingModeSchema>
export const DEFAULT_MEETING_MODE: MeetingMode = 'voice'
export const MEETING_MODE_LABELS: Record<MeetingMode, string> = { voice: 'Speaks', silent: 'Silent', listen: 'Listens in' }
export const MEETING_MODE_DESCRIPTIONS: Record<MeetingMode, string> = {
  voice: 'Answers aloud when addressed, shows its work on its tile and posts files in the chat.',
  silent: 'Never speaks. Replies go into the meeting chat and onto its tile; the tile still shows its browser and images.',
  listen: 'Gives the call nothing: listens and works for you in the background. Read its notes in the app.',
}

/**
 * What an installation sets for every meeting its agent joins. Providers store
 * it in their config; the family reads it through `configuredSettings()`.
 */
export const meetingIntegrationSettingsSchema = z.object({
  /** Shown as the participant's name in the call; the agent's name when empty. */
  botName: z.string().trim().min(1).max(100).optional(),
  /** Standing instructions for every meeting; the per-call brief comes on top. */
  instructions: z.string().trim().min(1).max(MEETING_INSTRUCTIONS_MAX_CHARS).optional(),
  /** How the agent takes part unless a join says otherwise. */
  mode: meetingModeSchema.optional(),
  /** The voice provider's voice id for calls; the provider's default when empty or unknown to it. */
  voice: z.string().trim().min(1).max(40).optional(),
})
export type MeetingIntegrationSettings = z.infer<typeof meetingIntegrationSettingsSchema>

export const joinMeetingInputSchema = z.object({
  meetingUrl: z.string().trim().min(1).max(2048),
  /** What the person wants from the agent in this meeting; becomes part of the agent's brief. */
  context: z.string().trim().max(4000).optional(),
  /** How the agent takes part in this call; the installation's setting when omitted. */
  mode: meetingModeSchema.optional(),
}).strict()

export const meetingIdInputSchema = z.object({ meetingId: z.string().uuid() }).strict()
export const sendMeetingChatInputSchema = z.object({
  /** Defaults to the one live meeting when omitted. */
  meetingId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(4096),
}).strict()
export const listMeetingsInputSchema = z.object({ limit: z.number().int().min(1).max(50).optional() }).strict()

/** Payload of the input events the family emits to itself. Only the family interprets it. */
export const meetingEventPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('join'), meetingId: z.string().uuid() }),
  z.object({ kind: z.literal('ended'), meetingId: z.string().uuid(), reason: z.string().max(200).optional() }),
])
/** A person in the call, as the bot host reports them. Ids are host-scoped and only compared within a meeting. */
export const meetingParticipantSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  isHost: z.boolean(),
})
export type MeetingParticipant = z.infer<typeof meetingParticipantSchema>

export const MEETING_PARTICIPANT_EVENT_KINDS = ['join', 'leave', 'update', 'speech_on', 'speech_off'] as const
export const meetingParticipantEventSchema = z.object({
  kind: z.enum(MEETING_PARTICIPANT_EVENT_KINDS),
  participant: meetingParticipantSchema,
})
export type MeetingParticipantEvent = z.infer<typeof meetingParticipantEventSchema>

/** Who is in the call right now and who is talking; the bot itself is never listed. */
export const meetingRosterSchema = z.object({
  participants: z.array(meetingParticipantSchema),
  speaking: z.array(z.string()),
})
export type MeetingRoster = z.infer<typeof meetingRosterSchema>

export const publicMeetingSchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  meetingUrl: z.string(),
  platform: meetingPlatformSchema,
  status: meetingStatusSchema,
  statusDetail: z.string().nullable(),
  botName: z.string(),
  mode: meetingModeSchema,
  sessionId: z.string().nullable(),
  context: z.string().nullable(),
  requestedAt: z.number(),
  joinedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  /** Until when the bot service keeps the call's audio; null for a call the bot never got into. */
  recordingRetainedUntil: z.number().nullable(),
})
export type PublicMeeting = z.infer<typeof publicMeetingSchema>

/** A link to a kept recording, as the management tool returns it. */
export const meetingRecordingLinkSchema = z.object({ url: z.string().url(), linkExpiresAt: z.number().nullable() })
