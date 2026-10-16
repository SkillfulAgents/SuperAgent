import { describe, expect, it, vi } from 'vitest'
import { RecallApiError, RecallClient } from './client'
import type { RecallTransport } from './transport'
import { RECALL_AUTOMATIC_LEAVE, RecallBotHost, recallBotStatus, recallRecordingLink } from './recall-meeting-integration'
import { MEETING_RECORDING_RETENTION_HOURS } from '../schemas'

const bot = (...codes: Array<[string, string | null]>) => ({
  id: 'bot-1', recordings: [],
  status_changes: codes.map(([code, sub_code], index) => ({ code, sub_code, message: null, created_at: new Date(index).toISOString() })),
})

describe('recallBotStatus', () => {
  it('maps the latest Recall status onto the family phases', () => {
    expect(recallBotStatus(bot(['ready', null], ['joining_call', null])).status).toBe('joining')
    expect(recallBotStatus(bot(['joining_call', null], ['in_waiting_room', null])).status).toBe('waiting_room')
    expect(recallBotStatus(bot(['in_waiting_room', null], ['in_call_not_recording', null])).status).toBe('in_call')
    expect(recallBotStatus(bot(['in_call_recording', null], ['call_ended', 'bot_kicked_from_call']))).toEqual({ status: 'ended', detail: 'bot_kicked_from_call' })
    expect(recallBotStatus(bot(['joining_call', null], ['fatal', 'meeting_not_found']))).toEqual({ status: 'failed', detail: 'meeting_not_found' })
  })
  it('keeps an unknown code non-terminal and shows it', () => {
    expect(recallBotStatus(bot(['in_call_recording', null], ['breakout_room_joined', null]))).toEqual({ status: 'joining', detail: 'breakout_room_joined' })
    expect(recallBotStatus({ id: 'x', status_changes: [], recordings: [] })).toEqual({ status: 'joining' })
  })
})

describe('recallRecordingLink', () => {
  const now = Date.parse('2026-10-13T12:00:00Z')
  const recording = (overrides: Record<string, unknown> = {}) => ({
    id: 'r', expires_at: '2026-10-20T12:00:00Z',
    media_shortcuts: { video_mixed: { data: { download_url: 'https://cdn.example/audio.mp4?sig=1' }, status: { code: 'done' } } }, ...overrides,
  })
  it('returns the mixed-media link while the recording is processed and retained', () => {
    expect(recallRecordingLink({ ...bot(), recordings: [recording()] }, now)).toEqual({ url: 'https://cdn.example/audio.mp4?sig=1', linkExpiresAt: now + 6 * 60 * 60 * 1000 })
  })
  it('has nothing while processing, after retention, or with no media', () => {
    expect(recallRecordingLink({ ...bot(), recordings: [recording({ media_shortcuts: { video_mixed: { data: null, status: { code: 'processing' } } } })] }, now)).toBeNull()
    expect(recallRecordingLink({ ...bot(), recordings: [recording({ expires_at: '2026-10-13T11:00:00Z' })] }, now)).toBeNull()
    expect(recallRecordingLink(bot(), now)).toBeNull()
  })
})

const alice = { agentSlug: 'helper', createdByUserId: 'alice' }
const unowned = { agentSlug: 'helper', createdByUserId: null }

const transport = (kind: RecallTransport['kind'] = 'platform'): RecallTransport => ({
  kind, baseUrl: kind === 'platform' ? 'https://proxy.example/v1/recall' : 'https://us-west-2.recall.ai/api/v1',
  authorization: async owner => kind === 'platform' ? `Bearer platform-token::${owner.createdByUserId ?? 'none'}` : 'Token key',
})

describe('RecallBotHost', () => {
  it('creates a bot whose camera is the participant page, attributed to the meeting owner through the proxy', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer platform-token::alice' })
      return new Response(JSON.stringify({ id: 'bot-7', status_changes: [] }), { status: 201 })
    })
    const host = new RecallBotHost(new RecallClient(transport(), alice, fetchImpl as typeof fetch))
    const result = await host.createBot({ meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'google_meet', botName: 'Ada', participantPageUrl: 'https://app.example/meeting/m1?token=t' })
    expect(result).toEqual({ botId: 'bot-7' })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://proxy.example/v1/recall/bot/')
    const body = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)
    expect(body).toMatchObject({
      meeting_url: 'https://meet.google.com/abc-defg-hij', bot_name: 'Ada',
      output_media: { camera: { kind: 'webpage', config: { url: 'https://app.example/meeting/m1?token=t' } } },
      // Audio only, kept for the documented window; the bot leaves an emptied room on its own.
      recording_config: { video_mixed_layout: 'audio_only', retention: { type: 'timed', hours: MEETING_RECORDING_RETENTION_HOURS } },
      automatic_leave: RECALL_AUTOMATIC_LEAVE,
    })
    expect(RECALL_AUTOMATIC_LEAVE.everyone_left_timeout.timeout).toBeLessThanOrEqual(60)
    expect(body.recording_config.realtime_endpoints).toBeUndefined()
    // Recordings are absent from a create response; the client tolerates that.
    expect(body.recordings).toBeUndefined()
  })
  it('asks for participant events at the callback URL when the family offers one', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'bot-8', status_changes: [] }), { status: 201 }))
    const host = new RecallBotHost(new RecallClient(transport('direct'), unowned, fetchImpl as unknown as typeof fetch))
    await host.createBot({ meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'google_meet', botName: 'Ada', participantPageUrl: 'https://app.example/meeting/m1?token=t', eventsUrl: 'https://app.example/api/meeting-participant/m1/events/?token=t' })
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe("https://us-west-2.recall.ai/api/v1/bot/")
    expect((fetchImpl.mock.calls[0] as unknown[])[1]).toMatchObject({ headers: { Authorization: 'Token key' } })
    const body = JSON.parse(((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body as string)
    expect(body.recording_config.realtime_endpoints).toEqual([{ type: 'webhook', url: 'https://app.example/api/meeting-participant/m1/events/?token=t', events: ['participant_events.join', 'participant_events.leave', 'participant_events.update'] }])
  })
  it('reduces Recall participant webhooks to family events and ignores the rest', () => {
    const host = new RecallBotHost(new RecallClient(transport(), unowned))
    expect(host.parseEvent({ event: 'participant_events.join', data: { data: { participant: { id: 100, name: 'Iddo', is_host: true } } } }))
      .toEqual({ kind: 'join', participant: { id: '100', name: 'Iddo', isHost: true } })
    expect(host.parseEvent({ event: 'participant_events.speech_on', data: { data: { participant: { id: '7', name: null } } } }))
      .toEqual({ kind: 'speech_on', participant: { id: '7', name: 'Unknown participant', isHost: false } })
    expect(host.parseEvent({ event: 'transcript.data', data: { data: {} } })).toBeNull()
    expect(host.parseEvent('nonsense')).toBeNull()
  })
  it('turns proxy refusals into messages a person can act on', async () => {
    const fetchImpl = vi.fn(async () => new Response('billing hold', { status: 402 }))
    const client = new RecallClient(transport(), alice, fetchImpl as unknown as typeof fetch)
    await expect(client.getBot('bot-1')).rejects.toMatchObject({ status: 402, message: expect.stringMatching(/billing/) })
    const down = new RecallClient(transport(), alice, (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch)
    await expect(down.leaveCall('bot-1')).rejects.toBeInstanceOf(RecallApiError)
  })
  it('has no recording for a bot Recall or the proxy no longer knows, and still surfaces other faults', async () => {
    const gone = new RecallBotHost(new RecallClient(transport(), alice, (async () => new Response('{"detail":"Not found."}', { status: 404 })) as unknown as typeof fetch))
    await expect(gone.recordingLink('bot-1')).resolves.toBeNull()
    const broken = new RecallBotHost(new RecallClient(transport(), alice, (async () => new Response('upstream error', { status: 502 })) as unknown as typeof fetch))
    await expect(broken.recordingLink('bot-1')).rejects.toMatchObject({ status: 502 })
  })
})
