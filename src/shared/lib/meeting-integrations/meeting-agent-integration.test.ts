import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { chatIntegrations } from '../db/schema'
import type { AgentIntegrationRecord, IntegrationInputEvent } from '../agent-integrations/types'
import type { MeetingBotHost, MeetingBotStatus } from './bot-host'
import type { MeetingIntegrationSettings } from './schemas'
import { InMemoryFileOps } from '../agent-actor/testing/in-memory-file-ops'

let database: AppDatabase
let handle: TestDatabase
vi.mock('../db', () => ({ get db() { return database } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))
let workspace = new InMemoryFileOps()
vi.mock('../agent-actor', () => ({
  agentCatalog: { get: vi.fn(async () => ({ slug: 'agent', name: 'Ada' })) },
  agentRegistry: { get: vi.fn(() => ({ files: workspace })) },
}))
vi.mock('../agent-integrations/app-link', () => ({ resolveInternetAppBaseUrl: vi.fn(() => 'https://app.example') }))
let authMode = false
let agentOwner: string | null = null
vi.mock('../auth/mode', () => ({ isAuthMode: () => authMode }))
vi.mock('../services/agent-owner', () => ({ getAgentOwnerUserId: vi.fn(async () => agentOwner) }))

const { MeetingAgentIntegration, MeetingPolicyError, MAX_CONSECUTIVE_POLL_FAILURES, MAX_MEETING_AGE_MS, MEETING_LOST_CONTACT_DETAIL, MEETING_POLL_INTERVAL_MS, MEETING_RECORDING_RETENTION_HOURS } = await import('./meeting-agent-integration')
const { getMeeting, listMeetings, toPublicMeeting, transitionMeeting, verifyParticipantToken } = await import('./store')
const { leaveOpenMeetings } = await import('./definitions')
const { meetingEventPayloadSchema } = await import('./schemas')
const { meetingRoster } = await import('./roster')
const { MEETING_TRANSCRIPT_FLUSH_MS, meetingTranscriptPath } = await import('./transcript')
const { backgroundSettled } = await import('../background')
const { receiveMeetingBotEvent, receiveMeetingSpeech } = await import('./bot-events')

const record: AgentIntegrationRecord = {
  id: 'integration', agentSlug: 'agent', provider: 'recall', name: null, config: '{}', status: 'active', errorMessage: null,
  createdByUserId: 'owner', llmProviderId: null, model: null, effort: null, speed: null, createdAt: new Date(), version: 0, updatedAt: new Date(),
}

class FakeHost implements MeetingBotHost {
  created: Array<{ meetingUrl: string; botName: string; participantPageUrl: string; eventsUrl?: string; framesUrl?: string }> = []
  status: MeetingBotStatus = { status: 'joining' }
  left: string[] = []
  chats: Array<[string, string]> = []
  fail = false
  unreachable = false
  /** When set, createBot waits until releaseCreate() so a test can act while the host is still starting the bot. */
  holdCreate = false
  private releases: Array<() => void> = []
  releaseCreate() { for (const release of this.releases.splice(0)) release() }
  async createBot(request: { meetingUrl: string; botName: string; participantPageUrl: string; eventsUrl?: string; framesUrl?: string }) {
    if (this.fail) throw new Error('Recall.ai has no bot capacity right now. Try again in a moment.')
    if (this.holdCreate) await new Promise<void>(resolve => this.releases.push(resolve))
    this.created.push(request); return { botId: `bot-${this.created.length}` }
  }
  async getBotStatus() { if (this.unreachable) throw new Error('503 from the bot host'); return this.status }
  failLeave = false
  async leaveCall(botId: string) { if (this.failLeave) throw new Error('503 from the bot host'); this.left.push(botId) }
  async sendChatMessage(botId: string, message: string) { this.chats.push([botId, message]) }
  async recordingLink(botId: string) { return { url: `https://cdn.example/${botId}.mp4`, linkExpiresAt: null } }
}

class TestIntegration extends MeetingAgentIntegration {
  readonly provider = 'recall'
  readonly definition = { provider: 'recall', name: 'Meetings', family: 'meeting', capabilities: [], settings: [], setup: { kind: 'api-key', credentialFields: [] } }
  settings: MeetingIntegrationSettings = {}
  constructor(readonly bots: FakeHost, private available = true) { super(record) }
  protected isAvailable() { return this.available }
  protected configuredSettings() { return this.settings }
}

let host: FakeHost
let integration: TestIntegration
let events: IntegrationInputEvent[]
beforeEach(async () => {
  vi.useFakeTimers()
  workspace = new InMemoryFileOps()
  authMode = false; agentOwner = null
  handle = await createTestDatabase(); database = handle.db
  await database.insert(chatIntegrations).values({ id: 'integration', provider: 'recall', agentSlug: 'agent', config: '{"apiKey":"k","region":"us-west-2"}', status: 'active', createdAt: new Date(), updatedAt: new Date() }).run()
  host = new FakeHost()
  integration = new TestIntegration(host)
  events = []
  integration.onEvent(event => { if (event.type === 'input') events.push(event) })
  await integration.connect()
})
afterEach(async () => { await integration.disconnect(); vi.useRealTimers(); await handle.close() })

describe('MeetingAgentIntegration', () => {
  it('joins: records the meeting, briefs the agent first, then sends the bot to the participant page', async () => {
    const tool = integration.getTools({ integration: record, externalId: '' }).find(tool => tool.name === 'join_meeting')!
    expect(tool.exposure).toBe('both')
    const meeting = await tool.execute({ meetingUrl: 'https://meet.google.com/abc-defg-hij', context: 'Take notes' }, { source: 'management', userId: 'alice' }) as { id: string; status: string; platform: string }
    expect(meeting).toMatchObject({ status: 'joining', platform: 'google_meet', botName: 'Ada' })
    // The agent session request went out before the bot was created.
    expect(events).toHaveLength(1)
    expect(meetingEventPayloadSchema.parse(events[0].payload)).toEqual({ kind: 'join', meetingId: meeting.id })
    expect(integration.resolveRoute(events[0])).toMatchObject({ action: 'run', externalId: meeting.id })
    expect(host.created[0]).toMatchObject({ botName: 'Ada', meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    const pageUrl = new URL(host.created[0].participantPageUrl)
    expect(pageUrl.origin + pageUrl.pathname).toBe(`https://app.example/meeting/${meeting.id}`)
    // The host's callback URL carries the same token, with the trailing slash Recall needs before the query.
    expect(host.created[0].eventsUrl).toBe(`https://app.example/api/meeting-participant/${meeting.id}/events/?token=${pageUrl.searchParams.get('token')}`)
    // Shared-screen frames come back over a websocket next to it, under the same token.
    expect(host.created[0].framesUrl).toBe(`wss://app.example/api/meeting-participant/${meeting.id}/frames/?token=${pageUrl.searchParams.get('token')}`)
    expect(await verifyParticipantToken(meeting.id, pageUrl.searchParams.get('token')!)).not.toBeNull()
    expect(await verifyParticipantToken(meeting.id, 'wrong')).toBeNull()
    expect((await getMeeting(meeting.id))?.createdByUserId).toBe('alice')
    const prepared = await integration.prepareInput(events[0], { integration: record, externalId: meeting.id, actor: {} as never })
    expect(prepared.text).toContain('Take notes')
    expect(prepared.text).toContain('Google Meet')
    expect(prepared.systemPrompt).toMatch(/spoken/)
    expect(prepared.systemPrompt).not.toContain('Standing instructions')
    // The installation's standing instructions ride along in the session prompt, read at brief time.
    integration.settings = { instructions: 'Never quote prices.' }
    const briefed = await integration.prepareInput(events[0], { integration: record, externalId: meeting.id, actor: {} as never })
    expect(briefed.systemPrompt).toContain('Standing instructions for every meeting you join:\nNever quote prices.')
    expect(briefed.text).not.toContain('Never quote prices')
  })

  it("with accounts, attributes the agent's own join to the installation's creator, else the agent's owner", async () => {
    authMode = true; agentOwner = 'bob'
    // The installation the agent set up itself has no creator (the beforeEach row).
    const first = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }, { source: 'agent' })
    expect((await getMeeting(first.id))?.createdByUserId).toBe('bob')
    await database.update(chatIntegrations).set({ createdByUserId: 'carol' }).run()
    const second = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/xyz-wxyz-xyz' }, { source: 'agent' })
    expect((await getMeeting(second.id))?.createdByUserId).toBe('carol')
  })

  it('with accounts, refuses a join nobody can be attributed to before briefing the agent or sending a bot', async () => {
    authMode = true
    await expect(integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }, { source: 'agent' })).rejects.toThrow(/no owner/)
    expect(host.created).toHaveLength(0)
    expect(events).toHaveLength(0)
    expect(await listMeetings('integration')).toHaveLength(0)
  })

  it('rejects links that are not meeting invites and inactive installations', async () => {
    await expect(integration.requestJoin({ meetingUrl: 'https://example.com/call' })).rejects.toBeInstanceOf(MeetingPolicyError)
    const paused = new TestIntegration(host, false)
    await expect(paused.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })).rejects.toThrow(/not active/)
    expect(host.created).toHaveLength(0)
  })

  it('marks the meeting failed and tells the agent when the host refuses the bot', async () => {
    host.fail = true
    await expect(integration.requestJoin({ meetingUrl: 'https://zoom.us/j/123?pwd=x' })).rejects.toThrow(/capacity/)
    const [meeting] = await listMeetings('integration')
    expect(meeting).toMatchObject({ status: 'failed', statusDetail: expect.stringContaining('capacity') })
    expect(events.map(event => meetingEventPayloadSchema.parse(event.payload).kind)).toEqual(['join', 'ended'])
  })

  it('follows the host status into the call and notifies the agent once the call ends', async () => {
    const meeting = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    host.status = { status: 'waiting_room' }
    await vi.advanceTimersByTimeAsync(5000)
    expect((await getMeeting(meeting.id))?.status).toBe('waiting_room')
    host.status = { status: 'in_call' }
    await vi.advanceTimersByTimeAsync(5000)
    expect((await getMeeting(meeting.id))).toMatchObject({ status: 'in_call', joinedAt: expect.any(Date) })
    // First thing in the call: the room learns what joined and that audio is kept.
    expect(host.chats).toEqual([['bot-1', expect.stringMatching(/I'm Ada, an AI assistant.*record this call's audio/)]])
    await integration.sendChat({ message: 'Notes: https://app.example/f' })
    expect(host.chats[1]).toEqual(['bot-1', 'Notes: https://app.example/f'])
    host.status = { status: 'ended', detail: 'call_ended_by_host' }
    await vi.advanceTimersByTimeAsync(5000)
    expect((await getMeeting(meeting.id))).toMatchObject({ status: 'ended', endedAt: expect.any(Date) })
    const ended = events.filter(event => meetingEventPayloadSchema.parse(event.payload).kind === 'ended')
    expect(ended).toHaveLength(1)
    expect((await integration.prepareInput(ended[0], { integration: record, externalId: meeting.id, actor: {} as never })).text).toMatch(/call has ended \(call_ended_by_host\)/)
    // A late poll cannot reopen it, and tracking stopped.
    host.status = { status: 'in_call' }
    await vi.advanceTimersByTimeAsync(10000)
    expect((await getMeeting(meeting.id))?.status).toBe('ended')
    expect(await transitionMeeting(meeting.id, 'in_call')).toBeNull()
  })

  it('reports lost contact with the host after the failure budget but keeps the meeting open and keeps trying', async () => {
    const meeting = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    host.status = { status: 'in_call' }
    await vi.advanceTimersByTimeAsync(MEETING_POLL_INTERVAL_MS)
    expect((await getMeeting(meeting.id))?.status).toBe('in_call')
    host.unreachable = true
    await vi.advanceTimersByTimeAsync(MEETING_POLL_INTERVAL_MS * (MAX_CONSECUTIVE_POLL_FAILURES - 1))
    expect(await getMeeting(meeting.id)).toMatchObject({ status: 'in_call', statusDetail: null })
    await vi.advanceTimersByTimeAsync(MEETING_POLL_INTERVAL_MS)
    // The bot may well still be in the call, so this is not the end of the meeting: no ended notice, Leave still reaches the bot.
    expect(await getMeeting(meeting.id)).toMatchObject({ status: 'in_call', statusDetail: MEETING_LOST_CONTACT_DETAIL, endedAt: null })
    expect(events.filter(event => meetingEventPayloadSchema.parse(event.payload).kind === 'ended')).toHaveLength(0)
    // The host coming back clears the notice; a later outage reports again.
    host.unreachable = false
    host.status = { status: 'in_call', detail: 'recording' }
    await vi.advanceTimersByTimeAsync(MEETING_POLL_INTERVAL_MS)
    expect(await getMeeting(meeting.id)).toMatchObject({ status: 'in_call', statusDetail: 'recording' })
    host.unreachable = true
    await vi.advanceTimersByTimeAsync(MEETING_POLL_INTERVAL_MS * MAX_CONSECUTIVE_POLL_FAILURES)
    expect((await getMeeting(meeting.id))?.statusDetail).toBe(MEETING_LOST_CONTACT_DETAIL)
    await integration.leave(meeting.id, 'done')
    expect(host.left).toEqual(['bot-1'])
    expect((await getMeeting(meeting.id))?.status).toBe('ended')
  })

  it('sends a bot home when leave was asked for while the host was still starting it', async () => {
    host.holdCreate = true
    const joining = integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    await vi.advanceTimersByTimeAsync(0)
    const [row] = await listMeetings('integration')
    expect(row.botId).toBeNull()
    // Nothing to send home yet, so the row stays open and says so.
    const asked = await integration.leave(row.id, 'changed my mind')
    expect(asked).toMatchObject({ status: 'requested', statusDetail: expect.stringMatching(/Leave requested/) })
    host.releaseCreate()
    const meeting = await joining
    expect(meeting).toMatchObject({ status: 'ended', statusDetail: 'Left before joining' })
    expect(host.created).toHaveLength(1)
    expect(host.left).toEqual(['bot-1'])
    expect(integration['pollers'].size).toBe(0)
  })

  it('keeps a bot it could not send home after a cancelled start tracked, so leave can be repeated', async () => {
    host.holdCreate = true
    const joining = integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    await vi.advanceTimersByTimeAsync(0)
    const [row] = await listMeetings('integration')
    await integration.leave(row.id, 'changed my mind')
    host.failLeave = true
    host.releaseCreate()
    const meeting = await joining
    expect(meeting).toMatchObject({ status: 'joining', statusDetail: expect.stringMatching(/could not be reached/) })
    expect((await getMeeting(row.id))?.botId).toBe('bot-1')
    expect(host.left).toEqual([])
    expect(integration['pollers'].size).toBe(1)
    // The host comes back: the next leave works and ends the meeting.
    host.failLeave = false
    await integration.leave(row.id, 'second try')
    expect(host.left).toEqual(['bot-1'])
    expect((await getMeeting(row.id))?.status).toBe('ended')
    expect(integration['pollers'].size).toBe(0)
  })

  it('starts one bot for two simultaneous requests for the same call', async () => {
    host.holdCreate = true
    const joins = Promise.all([
      integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }),
      integration.requestJoin({ meetingUrl: 'meet.google.com/abc-defg-hij', context: 'also me' }),
    ])
    await vi.advanceTimersByTimeAsync(0)
    host.releaseCreate()
    const [first, second] = await joins
    expect(second.id).toBe(first.id)
    expect(host.created).toHaveLength(1)
    expect(await listMeetings('integration')).toHaveLength(1)
  })

  it('posts files the agent delivers into the meeting chat as links, only while in the call', async () => {
    const meeting = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    const context = { integration: record, externalId: meeting.id }
    const delivered = (filePath: string, extra: Record<string, unknown> = {}) => ({
      type: 'runtime' as const,
      event: { type: 'tool_result_ready', toolName: 'mcp__user-input__deliver_file', toolUseId: 't', filePath, isError: false, ...extra },
    })
    // Not in the call yet: nothing to post to.
    await integration.deliver(context, delivered('/workspace/output/early.png'))
    host.status = { status: 'in_call' }
    await vi.advanceTimersByTimeAsync(5000)
    await integration.deliver(context, delivered('/workspace/output/q3 chart.png', { description: 'Q3 revenue chart' }))
    await integration.deliver(context, delivered('/workspace/notes.md'))
    // Failed deliveries, other tools and spoken replies are not relayed.
    await integration.deliver(context, delivered('/workspace/broken.pdf', { isError: true }))
    await integration.deliver(context, { type: 'runtime', event: { type: 'tool_result_ready', toolName: 'Read', toolUseId: 'r', filePath: '/workspace/x' } })
    await integration.deliver(context, { type: 'message', text: 'Here you go.' })
    expect(host.chats.slice(1)).toEqual([
      ['bot-1', 'Q3 revenue chart: https://app.example/api/agents/agent/files/output/q3%20chart.png?inline=true'],
      ['bot-1', 'notes.md: https://app.example/api/agents/agent/files/notes.md?inline=true'],
    ])
  })

  it('takes the mode from the join, else from the installation, and briefs the agent accordingly', async () => {
    integration.settings = { mode: 'silent' }
    const byDefault = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    expect(byDefault.mode).toBe('silent')
    expect((await getMeeting(byDefault.id))?.mode).toBe('silent')
    const prepared = await integration.prepareInput(events[0], { integration: record, externalId: byDefault.id, actor: {} as never })
    expect(prepared.text).toContain('silent participant')
    expect(prepared.systemPrompt).toContain('posted into the meeting chat as text')
    const picked = await integration.requestJoin({ meetingUrl: 'https://zoom.us/j/123456', mode: 'listen' })
    expect(picked.mode).toBe('listen')
    expect((await integration.prepareInput(events[1], { integration: record, externalId: picked.id, actor: {} as never })).systemPrompt).toContain('Nothing you write reaches the call')
    expect(toPublicMeeting((await getMeeting(picked.id))!).mode).toBe('listen')
  })

  it('posts a silent bot\'s written replies into the chat at message boundaries, and nothing for a listening bot', async () => {
    const silent = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij', mode: 'silent' })
    const context = { integration: record, externalId: silent.id }
    host.status = { status: 'in_call' }
    await vi.advanceTimersByTimeAsync(5000)
    const posted = () => host.chats.filter(([, text]) => !text.startsWith('Hi, I\'m')).map(([, text]) => text)
    await integration.deliver(context, { type: 'runtime', event: { type: 'stream_start' } })
    await integration.deliver(context, { type: 'runtime', event: { type: 'stream_delta', text: 'Checking the ' } })
    await integration.deliver(context, { type: 'runtime', event: { type: 'stream_delta', text: 'numbers.' } })
    // A tool starting closes the message so far; the next message starts fresh.
    await integration.deliver(context, { type: 'runtime', event: { type: 'tool_use_start', toolName: 'WebSearch' } })
    expect(posted()).toEqual(['Checking the numbers.'])
    await integration.deliver(context, { type: 'runtime', event: { type: 'stream_delta', text: 'Q3 revenue was 4.2M.' } })
    await integration.deliver(context, { type: 'turn-completed', event: { type: 'turn_completed' } })
    expect(posted()).toEqual(['Checking the numbers.', 'Q3 revenue was 4.2M.'])
    // Nothing accumulated: a boundary posts nothing.
    await integration.deliver(context, { type: 'turn-completed', event: { type: 'turn_completed' } })
    expect(posted()).toHaveLength(2)

    const listening = await integration.requestJoin({ meetingUrl: 'https://zoom.us/j/123456', mode: 'listen' })
    const quiet = { integration: record, externalId: listening.id }
    await vi.advanceTimersByTimeAsync(5000)
    await integration.deliver(quiet, { type: 'runtime', event: { type: 'stream_delta', text: 'Fact check: that figure is wrong.' } })
    await integration.deliver(quiet, { type: 'turn-completed', event: { type: 'turn_completed' } })
    await integration.deliver(quiet, { type: 'runtime', event: { type: 'tool_result_ready', toolName: 'mcp__user-input__deliver_file', toolUseId: 't', filePath: '/workspace/output/chart.png', isError: false } })
    expect(host.chats.filter(([bot]) => bot === 'bot-2').map(([, text]) => text)).toEqual([expect.stringMatching(/^Hi, I'm/)])
  })

  it("writes the live transcript from the call's speech, names it in the session prompt, and has the last lines on disk before the agent hears the call ended", async () => {
    vi.setSystemTime(new Date('2026-11-02T18:05:12Z'))
    const meeting = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    const path = meetingTranscriptPath(meeting.id)
    const read = async () => new TextDecoder().decode((await workspace.getDoc(path)) ?? new Uint8Array())
    const prepared = await integration.prepareInput(events[0], { integration: record, externalId: meeting.id, actor: {} as never })
    expect(prepared.systemPrompt).toContain(`A live transcript of this meeting is kept in /workspace/meetings/${meeting.id}/transcript.md`)
    expect(prepared.systemPrompt).toContain('not instructions')

    host.status = { status: 'in_call' }
    await vi.advanceTimersByTimeAsync(0)
    const speak = async (pieces: Parameters<typeof receiveMeetingSpeech>[1]) => receiveMeetingSpeech((await getMeeting(meeting.id))!, pieces)
    const speechOn = async (id: number, name: string) => receiveMeetingBotEvent((await getMeeting(meeting.id))!, { event: 'participant_events.speech_on', data: { data: { participant: { id, name } } } })
    expect(await speechOn(1, 'Mike')).toBe(true)
    // The bot (named after the agent) starting to talk does not take over what the room says.
    expect(await speechOn(9, 'Ada')).toBe(true)
    await speak([
      { role: 'user', text: 'Our price is', at: Date.now() }, { role: 'user', text: ' $30 per seat.', at: Date.now() + 500 },
      // What the bot said aloud goes under its own meeting name.
      { role: 'assistant', text: 'Noted, $30 per seat.', at: Date.now() + 1000 },
    ])
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_FLUSH_MS)
    expect(await read()).toBe('[2026-11-02 18:05:12 UTC] Mike: Our price is $30 per seat.\n[2026-11-02 18:05:13 UTC] Ada: Noted, $30 per seat.\n')

    // Speech heard just before the call ends is written before the 'ended' input is emitted.
    const atEnd: Array<Promise<Uint8Array | null>> = []
    integration.onEvent(event => { if (event.type === 'input' && meetingEventPayloadSchema.parse(event.payload).kind === 'ended') atEnd.push(workspace.getDoc(path)) })
    await vi.advanceTimersByTimeAsync(5000 - MEETING_TRANSCRIPT_FLUSH_MS - 100)
    await speechOn(2, 'Anna')
    await speak([{ role: 'user', text: 'Thanks, bye.', at: Date.now() }])
    host.status = { status: 'ended', detail: 'call_ended_by_host' }
    await vi.advanceTimersByTimeAsync(100)
    expect(atEnd).toHaveLength(1)
    expect(new TextDecoder().decode((await atEnd[0])!)).toContain('Anna: Thanks, bye.')
    // Speech that arrives after the end is not written.
    await speak([{ role: 'user', text: 'Late.', at: Date.now() }])
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_FLUSH_MS)
    expect(await read()).not.toContain('Late.')
  })

  it('keeps the roster from host events and forgets it when the call ends', async () => {
    const meeting = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    const rosters: Array<string[]> = []
    const watch = await meetingRoster.watch(meeting.id, roster => rosters.push(roster.participants.map(person => person.name)))
    // The callback route applies host events to the roster; the connector only ends it.
    const iddo = { id: '1', name: 'Iddo', isHost: true }
    await meetingRoster.apply(meeting.id, { kind: 'join', participant: iddo }, meeting.botName)
    await meetingRoster.apply(meeting.id, { kind: 'join', participant: { id: '2', name: 'Maya', isHost: false } }, meeting.botName)
    await backgroundSettled()
    expect(rosters.at(-1)).toEqual(['Iddo', 'Maya'])
    host.status = { status: 'ended', detail: 'everyone_left' }
    await vi.advanceTimersByTimeAsync(5000)
    await backgroundSettled()
    expect(await meetingRoster.get(meeting.id)).toEqual({ participants: [], speaking: [] })
    expect(rosters.at(-1)).toEqual([])
    await watch.stop()
    // A callback that was on its way when the call ended does not start the roster again.
    await meetingRoster.apply(meeting.id, { kind: 'join', participant: iddo }, meeting.botName)
    expect((await meetingRoster.get(meeting.id)).participants).toEqual([])
  })

  it('still tells the agent the call ended when the roster cannot be ended', async () => {
    const meeting = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    const clear = vi.spyOn(meetingRoster, 'clear').mockRejectedValueOnce(new Error('AppState unavailable'))
    host.status = { status: 'ended', detail: 'everyone_left' }
    await vi.advanceTimersByTimeAsync(5000)
    expect(clear).toHaveBeenCalledWith(meeting.id)
    expect((await getMeeting(meeting.id))?.status).toBe('ended')
    expect(events.map(event => meetingEventPayloadSchema.parse(event.payload).kind)).toEqual(['join', 'ended'])
    clear.mockRestore()
  })

  it('leaves on request and refuses chat when not in a call', async () => {
    const meeting = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    await expect(integration.sendChat({ message: 'hi' })).rejects.toThrow(/not in a meeting/)
    const left = await integration.leave(meeting.id, 'Asked to leave')
    expect(left.status).toBe('ended')
    expect(host.left).toEqual(['bot-1'])
    expect(events.map(event => meetingEventPayloadSchema.parse(event.payload).kind)).toEqual(['join', 'ended'])
  })

  it('resumes tracking open meetings when reconnected', async () => {
    const meeting = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    await integration.disconnect()
    host.status = { status: 'in_call' }
    await vi.advanceTimersByTimeAsync(10000)
    expect((await getMeeting(meeting.id))?.status).toBe('joining')
    await integration.connect()
    await vi.advanceTimersByTimeAsync(5000)
    expect((await getMeeting(meeting.id))?.status).toBe('in_call')
  })
  it('returns the meeting already under way instead of sending a second bot into the same call', async () => {
    const first = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    const again = await integration.requestJoin({ meetingUrl: 'meet.google.com/abc-defg-hij', context: 'retry' })
    expect(again.id).toBe(first.id)
    expect(host.created).toHaveLength(1)
    // A different call is a different meeting; an ended one can be rejoined.
    await integration.requestJoin({ meetingUrl: 'https://zoom.us/j/123' })
    await integration.leave(first.id, 'done')
    const rejoined = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    expect(rejoined.id).not.toBe(first.id)
    expect(host.created).toHaveLength(3)
  })

  it('hands out a recording link for an ended call only, and says how long the audio is kept', async () => {
    const meeting = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    const tool = integration.getTools({ integration: record, externalId: '' }).find(tool => tool.name === 'get_meeting_recording')!
    expect(tool.exposure).toBe('management')
    host.status = { status: 'in_call' }
    await vi.advanceTimersByTimeAsync(5000)
    expect(await tool.execute({ meetingId: meeting.id })).toBeNull()
    host.status = { status: 'ended' }
    await vi.advanceTimersByTimeAsync(5000)
    expect(await tool.execute({ meetingId: meeting.id })).toEqual({ url: 'https://cdn.example/bot-1.mp4', linkExpiresAt: null })
    const ended = (await listMeetings('integration'))[0]
    expect(ended.endedAt).toBeInstanceOf(Date)
    expect(toPublicMeeting(ended).recordingRetainedUntil).toBe(ended.endedAt!.getTime() + MEETING_RECORDING_RETENTION_HOURS * 3600 * 1000)
    // A call the bot never got into has no recording to speak of.
    host.fail = true
    await integration.requestJoin({ meetingUrl: 'https://zoom.us/j/999' }).catch(() => {})
    expect(toPublicMeeting((await listMeetings('integration'))[0]).recordingRetainedUntil).toBeNull()
  })

  it('closes rows abandoned past the maximum meeting length when it reconnects', async () => {
    const meeting = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    await integration.disconnect()
    vi.setSystemTime(Date.now() + MAX_MEETING_AGE_MS + 1000)
    await integration.connect()
    expect((await getMeeting(meeting.id))).toMatchObject({ status: 'ended', statusDetail: expect.stringMatching(/maximum length/) })
    expect(host.left).toEqual(['bot-1'])
    expect(events.map(event => meetingEventPayloadSchema.parse(event.payload).kind)).toEqual(['join', 'ended'])
  })

  it('leaves every open meeting of an installation on cleanup', async () => {
    const a = await integration.requestJoin({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    const b = await integration.requestJoin({ meetingUrl: 'https://zoom.us/j/123' })
    await meetingRoster.apply(a.id, { kind: 'join', participant: { id: '1', name: 'Iddo', isHost: true } }, a.botName)
    await leaveOpenMeetings('integration', host)
    expect(host.left.sort()).toEqual(['bot-1', 'bot-2'])
    expect(await meetingRoster.get(a.id)).toEqual({ participants: [], speaking: [] })
    expect((await getMeeting(a.id))?.status).toBe('ended')
    expect((await getMeeting(b.id))?.status).toBe('ended')
  })
})
