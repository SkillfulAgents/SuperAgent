import { z } from 'zod'
import { AgentIntegration } from '../agent-integrations/agent-integration'
import { IntegrationPolicyError } from '../agent-integrations/errors'
import type {
  AgentIntegrationRecord, IntegrationInputContext, IntegrationInputEvent, IntegrationOutput,
  IntegrationRoute, IntegrationSessionContext, IntegrationTool, IntegrationToolInvocation, PreparedIntegrationInput,
} from '../agent-integrations/types'
import { resolveInternetAppBaseUrl } from '../agent-integrations/app-link'
import { agentCatalog } from '../agent-actor'
import { workspaceBasename } from '../agent-actor/workspace-path'
import { publicWorkspaceFileUrl } from '../utils/workspace-file-url'
import { captureException } from '../error-reporting'
import { background } from '../background'
import { getAgentIntegration } from '../services/agent-integration-service'
import { getAgentOwnerUserId } from '../services/agent-owner'
import { isAuthMode } from '../auth/mode'
import type { MeetingBotHost, MeetingRecordingLink } from './bot-host'
import { meetingPolicy } from './definitions'
import { parseMeetingUrl, type ParsedMeetingUrl } from './meeting-url'
import { meetingEndedNotice, meetingJoinBrief, meetingRecordingDisclosure, meetingSessionSystemPrompt } from './prompts'
import {
  isTerminalMeetingStatus, joinMeetingInputSchema, listMeetingsInputSchema, MEETING_RECORDING_RETENTION_HOURS, meetingEventPayloadSchema,
  meetingIdInputSchema, sendMeetingChatInputSchema, DEFAULT_MEETING_MODE, type JoinMeetingInput, type MeetingIntegrationSettings, type MeetingStatus, type PublicMeeting,
} from './schemas'
import {
  createMeeting, getMeeting, listMeetings, listOpenMeetings, mintParticipantToken, setMeetingBot,
  setMeetingSession, toPublicMeeting, transitionMeeting, type MeetingRecord,
} from './store'
import { meetingRoster } from './roster'

export { MEETING_RECORDING_RETENTION_HOURS }

/** A refusal the person can act on: wrong link, not in a call, integration paused. */
export class MeetingPolicyError extends IntegrationPolicyError {}

/** The runtime events that bound one written reply: text arriving, and the boundaries that post it. */
const runtimeTextEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stream_delta'), text: z.string() }),
  z.object({ type: z.literal('stream_start') }),
  z.object({ type: z.literal('tool_use_start') }),
])
/** A written reply is one chat message; Recall caps those well below this. */
const MAX_WRITTEN_REPLY_CHARS = 16_000
const MAX_CHAT_MESSAGE_CHARS = 4096

const deliveredFileEventSchema = z.object({
  type: z.literal('tool_result_ready'),
  toolName: z.literal('mcp__user-input__deliver_file'),
  filePath: z.string().min(1),
  description: z.string().optional(),
  isError: z.boolean().optional(),
})

/** How often the family asks the host where its bot is. Webhooks can replace this behind the same transitions. */
export const MEETING_POLL_INTERVAL_MS = 5000
export const MAX_CONSECUTIVE_POLL_FAILURES = 24
export const MEETING_LOST_CONTACT_DETAIL = 'Lost contact with the meeting bot host; still trying'
/**
 * No meeting runs this long. A row still open after it was abandoned by a
 * crash, a lost webhook or a host that never answered; on reconnect the bot is
 * told to leave (it has long since done so on its own) and the row is closed.
 */
export const MAX_MEETING_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Provider-independent meeting lifecycle: one agent session per meeting, the
 * join brief, status tracking, and the tools a person or the agent uses to
 * bring the agent into a call. Providers supply only a `MeetingBotHost`.
 *
 * The voice loop itself is not here: the bot's browser loads the participant
 * page, which runs the same voice stack as the app against the meeting's session.
 */
export abstract class MeetingAgentIntegration extends AgentIntegration {
  constructor(protected readonly record: AgentIntegrationRecord) { super() }
  protected abstract readonly bots: MeetingBotHost
  /** Whether the host can be reached at all; checked before every host call. */
  protected abstract isAvailable(): boolean
  /** The installation's settings for every meeting: name in calls, standing instructions, default mode, voice. */
  protected abstract configuredSettings(): MeetingIntegrationSettings

  private connected = false
  private pollers = new Map<string, { timer: ReturnType<typeof setTimeout>; failures: number }>()

  async connect(): Promise<void> {
    this.connected = true
    const cutoff = Date.now() - MAX_MEETING_AGE_MS
    for (const meeting of await listOpenMeetings(this.record.id)) {
      if (meeting.requestedAt.getTime() < cutoff) { await this.expire(meeting); continue }
      if (meeting.botId) this.track(meeting.id)
    }
  }
  async disconnect(): Promise<void> {
    this.connected = false
    for (const [id] of this.pollers) this.untrack(id)
  }
  isConnected(): boolean { return this.connected }

  resolveRoute(event: IntegrationInputEvent): IntegrationRoute {
    const payload = meetingEventPayloadSchema.parse(event.payload)
    return { action: 'run', externalId: payload.meetingId, interactionId: event.id }
  }
  isAllowed = meetingPolicy.isAllowed
  sessionPolicy = meetingPolicy.sessionPolicy
  async authorize(context: IntegrationSessionContext): Promise<boolean> {
    return this.isAvailable() && this.isAllowed(context)
  }

  async prepareInput(event: IntegrationInputEvent, context: IntegrationInputContext): Promise<PreparedIntegrationInput> {
    const payload = meetingEventPayloadSchema.parse(event.payload)
    const meeting = await getMeeting(payload.meetingId)
    if (!meeting) return { text: '', skip: true }
    if (payload.kind === 'ended') return { text: meetingEndedNotice(payload.reason) }
    const agent = await agentCatalog.get(context.integration.agentSlug)
    return { text: meetingJoinBrief(meeting, agent?.name ?? meeting.botName), systemPrompt: meetingSessionSystemPrompt(this.configuredSettings().instructions, meeting.mode) }
  }

  /**
   * The participant page follows the session stream itself, so spoken replies
   * need no relay. Files are the exception: the bot cannot drop bytes into the
   * call, so every file the agent delivers is posted into the meeting chat as a
   * link (the page shows images on the camera on its own).
   */
  async deliver(context: IntegrationSessionContext, output: IntegrationOutput): Promise<void> {
    const meeting = await getMeeting(context.externalId)
    if (!meeting) return
    // A listening bot gives the call nothing; the person reads the session in the app.
    if (meeting.mode === 'listen') return
    if (meeting.mode === 'silent') await this.deliverWrittenReply(meeting, output)
    if (output.type !== 'runtime') return
    const delivered = deliveredFileEventSchema.safeParse(output.event)
    if (!delivered.success || delivered.data.isError) return
    const baseUrl = resolveInternetAppBaseUrl()
    if (!meeting.botId || meeting.status !== 'in_call' || !baseUrl) return
    const { filePath, description } = delivered.data
    const line = `${description?.trim() || workspaceBasename(filePath)}: ${publicWorkspaceFileUrl(baseUrl, context.integration.agentSlug, filePath)}`
    try { await this.bots.sendChatMessage(meeting.botId, line) }
    catch (error) {
      captureException(error, { tags: { component: 'meeting-integration', operation: 'share-file' }, extra: { meetingId: meeting.id, filePath } })
    }
  }

  /** Text the agent is writing in the current turn, per meeting, until a message boundary posts it. */
  private writtenReplies = new Map<string, string>()

  /**
   * A silent bot's replies go into the call's chat: each assistant message is
   * posted whole at its boundary (the next message starting, a tool starting,
   * or the turn ending), the way the chat families finalize streamed text.
   */
  private async deliverWrittenReply(meeting: MeetingRecord, output: IntegrationOutput): Promise<void> {
    const event = output.type === 'runtime' || output.type === 'turn-completed' || output.type === 'turn-failed'
      ? runtimeTextEventSchema.safeParse(output.event) : null
    const kind = output.type === 'turn-completed' || output.type === 'turn-failed' || output.type === 'session-reset' ? 'boundary'
      : event?.success ? event.data.type : null
    if (!kind) return
    if (kind === 'stream_delta') {
      this.writtenReplies.set(meeting.id, ((this.writtenReplies.get(meeting.id) ?? '') + (event?.success && event.data.type === 'stream_delta' ? event.data.text : '')).slice(-MAX_WRITTEN_REPLY_CHARS))
      return
    }
    const text = this.writtenReplies.get(meeting.id)?.trim()
    this.writtenReplies.delete(meeting.id)
    if (!text || !meeting.botId || meeting.status !== 'in_call') return
    try { await this.bots.sendChatMessage(meeting.botId, text.slice(0, MAX_CHAT_MESSAGE_CHARS)) }
    catch (error) {
      captureException(error, { tags: { component: 'meeting-integration', operation: 'post-reply' }, extra: { meetingId: meeting.id } })
    }
  }

  observeSession(context: IntegrationSessionContext): void {
    if (!context.sessionId) return
    background(setMeetingSession(context.externalId, context.sessionId).catch(error => {
      captureException(error, { tags: { component: 'meeting-integration', operation: 'record-session' }, extra: { meetingId: context.externalId } })
    }), { name: 'meeting-integration.record-session' })
  }

  getTools(_context: IntegrationSessionContext): readonly IntegrationTool[] {
    return [
      {
        name: 'join_meeting', exposure: 'both',
        description: 'Join a Zoom, Google Meet or Microsoft Teams call as a voice participant. Pass the invite URL (with any embedded passcode) and a brief of what is wanted in the call.',
        inputSchema: z.toJSONSchema(joinMeetingInputSchema),
        execute: (input, invocation) => this.requestJoin(input, invocation),
      },
      {
        name: 'leave_meeting', exposure: 'both',
        description: 'Leave a meeting the agent is attending.',
        inputSchema: z.toJSONSchema(meetingIdInputSchema),
        execute: input => this.leave(meetingIdInputSchema.parse(input).meetingId, 'Asked to leave'),
      },
      {
        name: 'list_meetings', exposure: 'both',
        description: 'Recent and current meetings for this integration, newest first.',
        inputSchema: z.toJSONSchema(listMeetingsInputSchema),
        execute: async input => (await listMeetings(this.record.id, listMeetingsInputSchema.parse(input ?? {}).limit)).map(toPublicMeeting),
      },
      {
        name: 'send_meeting_chat', exposure: 'both',
        description: 'Post a text message into the chat of a meeting the agent is in, such as a link. To share a file or show an image, use deliver_file instead; speech stays spoken.',
        inputSchema: z.toJSONSchema(sendMeetingChatInputSchema),
        execute: input => this.sendChat(input),
      },
      {
        // People only: the link is to the raw audio the bot kept, for the integration page.
        name: 'get_meeting_recording', exposure: 'management',
        description: 'A fresh link to the audio recording of an ended meeting, while the bot service still keeps it.',
        inputSchema: z.toJSONSchema(meetingIdInputSchema),
        execute: input => this.recordingLink(meetingIdInputSchema.parse(input).meetingId),
      },
    ]
  }

  // ── Operations ────────────────────────────────────────────────────────

  /** Joins in flight by invite URL, so two requests for the same call made at once share one bot. */
  private pendingJoins = new Map<string, Promise<PublicMeeting>>()
  /** Meetings asked to leave before their bot existed; the join sends the bot home once it does. */
  private cancelRequested = new Set<string>()

  async requestJoin(input: unknown, invocation?: IntegrationToolInvocation): Promise<PublicMeeting> {
    const request = joinMeetingInputSchema.parse(input)
    const parsed = parseMeetingUrl(request.meetingUrl)
    if (!parsed) throw new MeetingPolicyError('That does not look like a Zoom, Google Meet or Microsoft Teams invite link.')
    const pending = this.pendingJoins.get(parsed.url)
    if (pending) return pending
    const join = this.join(parsed, request, invocation).finally(() => this.pendingJoins.delete(parsed.url))
    this.pendingJoins.set(parsed.url, join)
    return join
  }

  private async join(parsed: ParsedMeetingUrl, request: JoinMeetingInput, invocation?: IntegrationToolInvocation): Promise<PublicMeeting> {
    const current = await this.requireActive()
    const baseUrl = resolveInternetAppBaseUrl()
    if (!baseUrl) throw new MeetingPolicyError('This app has no public HTTPS address for the meeting bot to load (HOST_PUBLIC_URL).')
    // One bot per installation per call. Asking twice (a person and the agent,
    // or a retry) returns the meeting already under way; several agents may
    // each bring their own bot into the same call.
    const existing = (await listOpenMeetings(current.id)).find(meeting => meeting.meetingUrl === parsed.url)
    if (existing) return toPublicMeeting(existing)
    // With accounts, the participant page acts for this person (participant-credential.ts)
    // and cannot authenticate without one: whoever asked, else the installation's
    // creator, else the agent's owner (an agent that set itself up has no creator).
    const createdByUserId = invocation?.userId ?? current.createdByUserId ?? await getAgentOwnerUserId(current.agentSlug)
    if (isAuthMode() && !createdByUserId) throw new MeetingPolicyError('This agent has no owner for the meeting bot to act for.')
    const agent = await agentCatalog.get(current.agentSlug)
    const settings = this.configuredSettings()
    const botName = settings.botName ?? agent?.name ?? current.name ?? 'Gamut'
    const token = mintParticipantToken()
    const meeting = await createMeeting({
      integrationId: current.id, agentSlug: current.agentSlug, meetingUrl: parsed.url, platform: parsed.platform, botName,
      // The join may pick how the agent takes part; the installation's setting applies otherwise.
      mode: request.mode ?? settings.mode ?? DEFAULT_MEETING_MODE,
      context: request.context, createdByUserId, participantToken: token,
    })
    // The agent's session starts now so it is briefed before the bot is let in.
    await this.emitEvent({ type: 'input', id: crypto.randomUUID(), externalId: meeting.id, timestamp: new Date(), payload: { kind: 'join', meetingId: meeting.id } })
    try {
      const participantPath = `${baseUrl}/api/meeting-participant/${encodeURIComponent(meeting.id)}`
      const { botId } = await this.bots.createBot({
        meetingUrl: parsed.url, platform: parsed.platform, botName,
        participantPageUrl: `${baseUrl}/meeting/${encodeURIComponent(meeting.id)}?token=${encodeURIComponent(token)}`,
        // The same one-time token authenticates the host's callbacks: both URLs are handed only to the host.
        eventsUrl: `${participantPath}/events/?token=${encodeURIComponent(token)}`,
      })
      await setMeetingBot(meeting.id, botId)
      if (this.cancelRequested.delete(meeting.id)) {
        // Someone asked to leave while the host was still starting the bot. Send it
        // home now that it exists; if the host cannot be reached the row stays open
        // and tracked, so Leave can be repeated and the expiry sweep still finds it.
        try {
          await this.bots.leaveCall(botId)
          await this.settle(meeting.id, 'ended', 'Left before joining')
        } catch (error) {
          captureException(error, { tags: { component: 'meeting-integration', operation: 'leave-after-cancel' }, extra: { meetingId: meeting.id } })
          await transitionMeeting(meeting.id, 'joining', 'Leave requested, but the meeting bot host could not be reached; try again')
          this.track(meeting.id)
        }
        return toPublicMeeting((await getMeeting(meeting.id))!)
      }
      await transitionMeeting(meeting.id, 'joining')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The meeting bot could not be started'
      await transitionMeeting(meeting.id, 'failed', message)
      await this.notifyEnded(meeting.id, `could not join: ${message}`)
      throw error
    }
    this.track(meeting.id)
    return toPublicMeeting((await getMeeting(meeting.id))!)
  }

  /**
   * A callback from the bot host about the room (someone joined, left, started
   * talking). The route has already checked the meeting's token. Returns
   * whether the body was a participant event at all.
   */
  async receiveBotEvent(meetingId: string, body: unknown): Promise<boolean> {
    const event = this.bots.parseEvent(body)
    if (!event) return false
    const meeting = await getMeeting(meetingId)
    if (!meeting || isTerminalMeetingStatus(meeting.status)) return true
    meetingRoster.apply(meeting.id, event, meeting.botName)
    return true
  }

  async leave(meetingId: string, reason: string): Promise<PublicMeeting> {
    const meeting = await this.requireMeeting(meetingId)
    if (isTerminalMeetingStatus(meeting.status)) return toPublicMeeting(meeting)
    if (!meeting.botId) {
      // The host is still starting the bot, so there is nothing to send home yet.
      // The row stays open until the join can do it: ending it now would leave a
      // bot nobody tracks in the call.
      this.cancelRequested.add(meeting.id)
      await transitionMeeting(meeting.id, meeting.status, 'Leave requested; the meeting bot is still being started')
      return toPublicMeeting((await getMeeting(meeting.id))!)
    }
    await this.bots.leaveCall(meeting.botId)
    await this.settle(meeting.id, 'ended', reason)
    return toPublicMeeting((await getMeeting(meeting.id))!)
  }

  async sendChat(input: unknown): Promise<{ sent: true }> {
    const request = sendMeetingChatInputSchema.parse(input)
    const meeting = request.meetingId ? await this.requireMeeting(request.meetingId) : await this.onlyLiveMeeting()
    if (meeting.status !== 'in_call' || !meeting.botId) throw new MeetingPolicyError('The agent is not in that meeting right now.')
    await this.bots.sendChatMessage(meeting.botId, request.message)
    return { sent: true }
  }

  async recordingLink(meetingId: string): Promise<MeetingRecordingLink | null> {
    const meeting = await this.requireMeeting(meetingId)
    if (meeting.status !== 'ended' || !meeting.botId || !this.bots.recordingLink) return null
    return this.bots.recordingLink(meeting.botId)
  }

  // ── Status tracking ───────────────────────────────────────────────────

  private track(meetingId: string): void {
    if (this.pollers.has(meetingId) || !this.connected) return
    const schedule = () => {
      const entry = this.pollers.get(meetingId)
      if (!entry) return
      entry.timer = setTimeout(() => background(this.poll(meetingId).then(schedule), { name: 'meeting-integration.poll' }), MEETING_POLL_INTERVAL_MS)
    }
    this.pollers.set(meetingId, { timer: setTimeout(() => background(this.poll(meetingId).then(schedule), { name: 'meeting-integration.poll' }), 0), failures: 0 })
  }
  private untrack(meetingId: string): void {
    const entry = this.pollers.get(meetingId)
    if (entry) clearTimeout(entry.timer)
    this.pollers.delete(meetingId)
  }

  private async poll(meetingId: string): Promise<void> {
    const entry = this.pollers.get(meetingId)
    const meeting = await getMeeting(meetingId)
    if (!entry || !meeting?.botId || isTerminalMeetingStatus(meeting.status)) { this.untrack(meetingId); return }
    if (meeting.requestedAt.getTime() < Date.now() - MAX_MEETING_AGE_MS) { await this.expire(meeting); return }
    try {
      const status = await this.bots.getBotStatus(meeting.botId)
      entry.failures = 0
      await this.settle(meetingId, status.status, status.detail)
    } catch (error) {
      entry.failures += 1
      if (entry.failures === MAX_CONSECUTIVE_POLL_FAILURES) {
        captureException(error, { tags: { component: 'meeting-integration', operation: 'poll' }, extra: { meetingId } })
        // Not terminal: for all we know the bot is still in the call, recording and
        // billing, so Leave and the expiry sweep must keep reaching it. The row says
        // what is going on and polling continues until the host answers again or the
        // meeting ages out.
        await transitionMeeting(meetingId, meeting.status, MEETING_LOST_CONTACT_DETAIL)
      }
    }
  }

  /** Apply a host-reported state; a terminal state stops tracking and tells the agent. */
  private async settle(meetingId: string, status: MeetingStatus, detail?: string): Promise<void> {
    const changed = await transitionMeeting(meetingId, status, detail)
    if (!changed) return
    if (changed.status === 'in_call' && changed.botId) await this.disclose(changed)
    if (!isTerminalMeetingStatus(changed.status)) return
    this.untrack(meetingId)
    meetingRoster.clear(meetingId)
    this.writtenReplies.delete(meetingId)
    await this.notifyEnded(meetingId, changed.status === 'failed' ? `could not join: ${detail ?? 'unknown error'}` : detail)
  }

  /** First thing in the call: who the bot is and that the audio is kept. Best effort; the call goes on without it. */
  private async disclose(meeting: MeetingRecord): Promise<void> {
    try { await this.bots.sendChatMessage(meeting.botId!, meetingRecordingDisclosure(meeting.botName, meeting.mode)) }
    catch (error) {
      captureException(error, { tags: { component: 'meeting-integration', operation: 'disclose' }, extra: { meetingId: meeting.id }, level: 'warning' })
    }
  }

  /** Close a row the host should have closed long ago; the bot is asked to leave in case it is still there. */
  private async expire(meeting: MeetingRecord): Promise<void> {
    if (meeting.botId) await this.bots.leaveCall(meeting.botId).catch(() => {})
    await this.settle(meeting.id, 'ended', 'The meeting ran past the maximum length and was closed')
  }

  private async notifyEnded(meetingId: string, reason?: string): Promise<void> {
    try {
      await this.emitEvent({ type: 'input', id: crypto.randomUUID(), externalId: meetingId, timestamp: new Date(), payload: { kind: 'ended', meetingId, reason } })
    } catch (error) {
      captureException(error, { tags: { component: 'meeting-integration', operation: 'notify-ended' }, extra: { meetingId } })
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async requireActive(): Promise<AgentIntegrationRecord> {
    const current = await getAgentIntegration(this.record.id)
    if (!current || current.status !== 'active' || !this.isAvailable()) throw new MeetingPolicyError('The meeting integration is not active.')
    return current
  }
  private async requireMeeting(meetingId: string): Promise<MeetingRecord> {
    const meeting = await getMeeting(meetingId)
    if (!meeting || meeting.integrationId !== this.record.id) throw new MeetingPolicyError('Unknown meeting.')
    return meeting
  }
  private async onlyLiveMeeting(): Promise<MeetingRecord> {
    const live = (await listOpenMeetings(this.record.id)).filter(meeting => meeting.status === 'in_call')
    if (live.length !== 1) throw new MeetingPolicyError(live.length ? 'Several meetings are live; name the meeting.' : 'The agent is not in a meeting right now.')
    return live[0]
  }
}
