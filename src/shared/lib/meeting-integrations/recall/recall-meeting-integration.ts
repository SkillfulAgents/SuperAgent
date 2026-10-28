import { z } from 'zod'
import type { AgentIntegrationRecord } from '../../agent-integrations/types'
import type { MeetingBotHost, MeetingBotJoinRequest, MeetingBotStatus, MeetingRecordingLink } from '../bot-host'
import type { MeetingIntegrationSettings, MeetingParticipantEvent } from '../schemas'
import { MeetingAgentIntegration, MEETING_RECORDING_RETENTION_HOURS } from '../meeting-agent-integration'
import { RecallApiError, RecallClient, type RecallBot } from './client'
import { parseRecallConfig, type RecallConfig } from './config'
import { recallDefinition } from './definition'
import { resolveRecallTransport } from './transport'

/**
 * Recall.ai status codes → family phases. Codes are open-ended on their side;
 * anything unknown keeps the current phase but surfaces the message.
 * https://docs.recall.ai/docs/bot-status-change-events
 */
export function recallBotStatus(bot: RecallBot): MeetingBotStatus {
  const latest = bot.status_changes.at(-1)
  if (!latest) return { status: 'joining' }
  const detail = [latest.sub_code, latest.message].filter(Boolean).join(': ') || undefined
  switch (latest.code) {
    case 'ready': case 'joining_call': return { status: 'joining', detail }
    case 'in_waiting_room': return { status: 'waiting_room', detail }
    case 'in_call_not_recording': case 'in_call_recording': case 'recording_permission_allowed': case 'recording_permission_denied':
      return { status: 'in_call', detail }
    case 'call_ended': case 'done': case 'media_expired': case 'analysis_done': case 'analysis_failed':
      return { status: 'ended', detail }
    case 'fatal': return { status: 'failed', detail: detail ?? 'The bot could not join' }
    default: return { status: 'joining', detail: `${latest.code}${detail ? `: ${detail}` : ''}` }
  }
}

/** Recall signs recording links for six hours; the family treats them as momentary and re-fetches. */
const RECALL_RECORDING_LINK_TTL_MS = 6 * 60 * 60 * 1000

export function recallRecordingLink(bot: RecallBot, now = Date.now()): MeetingRecordingLink | null {
  for (const recording of bot.recordings) {
    const url = recording.media_shortcuts?.video_mixed?.data?.download_url
    if (!url || recording.media_shortcuts?.video_mixed?.status?.code !== 'done') continue
    const retained = recording.expires_at ? Date.parse(recording.expires_at) : NaN
    if (Number.isFinite(retained) && retained <= now) continue
    return { url, linkExpiresAt: now + RECALL_RECORDING_LINK_TTL_MS }
  }
  return null
}

/**
 * The bot's leave rules. `everyone_left_timeout` arms once the bot has seen a
 * participant and fires when the room has been empty for that long; the bot
 * alone in a meeting nobody ended leaves in half a minute rather than sitting
 * through Recall's silence timeout.
 */
export const RECALL_AUTOMATIC_LEAVE = {
  waiting_room_timeout: 600, noone_joined_timeout: 600, everyone_left_timeout: { timeout: 30, activate_after: 0 },
  in_call_not_recording_timeout: 3600,
} as const

export class RecallBotHost implements MeetingBotHost {
  constructor(private readonly client: RecallClient) {}

  async createBot(request: MeetingBotJoinRequest): Promise<{ botId: string }> {
    const bot = await this.client.createBot({
      meeting_url: request.meetingUrl,
      bot_name: request.botName,
      // The participant page is the bot's camera and, through it, its microphone and speaker.
      output_media: { camera: { kind: 'webpage', config: { url: request.participantPageUrl } } },
      variant: { zoom: 'web_4_core', google_meet: 'web_4_core', microsoft_teams: 'web_4_core' },
      // The bot records the room's mixed audio: Recall only reports who is in
      // the call (participant events) while it records, and the recording is
      // what the integration page later links to. Video is not captured, and
      // the audio is deleted after the retention window. The family discloses
      // this in the call.
      recording_config: {
        video_mixed_layout: 'audio_only', retention: { type: 'timed', hours: MEETING_RECORDING_RETENTION_HOURS },
        ...(request.eventsUrl ? { realtime_endpoints: [{ type: 'webhook', url: request.eventsUrl, events: RECALL_PARTICIPANT_EVENTS }] } : {}),
      },
      automatic_leave: RECALL_AUTOMATIC_LEAVE,
    })
    return { botId: bot.id }
  }
  async getBotStatus(botId: string): Promise<MeetingBotStatus> { return recallBotStatus(await this.client.getBot(botId)) }
  leaveCall(botId: string): Promise<void> { return this.client.leaveCall(botId) }
  sendChatMessage(botId: string, message: string): Promise<void> { return this.client.sendChatMessage(botId, message) }
  parseEvent(body: unknown): MeetingParticipantEvent | null { return recallParticipantEvent(body) }
  async recordingLink(botId: string): Promise<MeetingRecordingLink | null> {
    try {
      return recallRecordingLink(await this.client.getBot(botId))
    } catch (error) {
      // Recall forgets a bot once its retention lapses, and the proxy answers 404 for
      // bots it did not create: either way there is no recording, not a fault.
      if (error instanceof RecallApiError && error.status === 404) return null
      throw error
    }
  }
}

/** Real-time webhook events the host asks Recall for. Speech events can be added here when the room needs them. */
export const RECALL_PARTICIPANT_EVENTS = ['participant_events.join', 'participant_events.leave', 'participant_events.update'] as const

const recallParticipantEventSchema = z.object({
  event: z.string(),
  data: z.object({
    data: z.object({
      participant: z.object({
        id: z.union([z.number(), z.string()]),
        name: z.string().nullable().optional(),
        is_host: z.boolean().nullable().optional(),
      }),
    }),
  }),
})

const RECALL_EVENT_KINDS: Record<string, MeetingParticipantEvent['kind']> = {
  'participant_events.join': 'join', 'participant_events.leave': 'leave', 'participant_events.update': 'update',
  'participant_events.speech_on': 'speech_on', 'participant_events.speech_off': 'speech_off',
}

/** Recall's real-time participant webhook, reduced to what the family tracks. */
export function recallParticipantEvent(body: unknown): MeetingParticipantEvent | null {
  const parsed = recallParticipantEventSchema.safeParse(body)
  if (!parsed.success) return null
  const kind = RECALL_EVENT_KINDS[parsed.data.event]
  if (!kind) return null
  const { participant } = parsed.data.data.data
  return { kind, participant: { id: String(participant.id), name: participant.name?.trim() || 'Unknown participant', isHost: participant.is_host === true } }
}

/** The host for one installation, over whatever transport this deployment has; null when it has none. */
export function recallBotHostFor(record: Pick<AgentIntegrationRecord, 'agentSlug' | 'createdByUserId'>): RecallBotHost | null {
  const transport = resolveRecallTransport()
  return transport ? new RecallBotHost(new RecallClient(transport, record)) : null
}

export class RecallMeetingIntegration extends MeetingAgentIntegration {
  readonly provider = 'recall'
  readonly definition = recallDefinition
  private readonly config: RecallConfig | null
  protected readonly bots: MeetingBotHost

  constructor(record: AgentIntegrationRecord, host?: MeetingBotHost) {
    super(record)
    let config: RecallConfig | null = null
    try { config = parseRecallConfig(record.config) } catch { config = null }
    this.config = config
    this.bots = host ?? recallBotHostFor(record) ?? UNREACHABLE_HOST
  }
  protected isAvailable(): boolean { return this.bots !== UNREACHABLE_HOST }
  protected configuredSettings(): MeetingIntegrationSettings { return this.config ?? {} }
}

/** Stands in when the deployment lost its transport after the installation was made; every operation refuses. */
const UNREACHABLE_HOST: MeetingBotHost = {
  async createBot() { throw new Error('Meetings are not available on this deployment.') },
  async getBotStatus() { throw new Error('Meetings are not available on this deployment.') },
  async leaveCall() { throw new Error('Meetings are not available on this deployment.') },
  async sendChatMessage() { throw new Error('Meetings are not available on this deployment.') },
  parseEvent: () => null,
}
