import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { chatIntegrations } from '@shared/lib/db/schema'
import { appState, type Subscription } from '@shared/lib/app-state'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('@shared/lib/agent-actor', () => ({ agentCatalog: { get: vi.fn(async () => ({ slug: 'agent', name: 'Ada', avatar: { color: 'tonal-blue', shape: 'hexagon' } })) } }))
const { createMeeting, mintParticipantToken, setMeetingSession, transitionMeeting } = await import('@shared/lib/meeting-integrations/store')
const { meetingRoster } = await import('@shared/lib/meeting-integrations/roster')
const { meetingSpeakersKey } = await import('@shared/lib/meeting-integrations/transcript-speakers')
const { default: router } = await import('./meeting-participant')
const app = new Hono().route('/api/meeting-participant', router)

let meetingId: string
let token: string
beforeEach(async () => {
  vi.clearAllMocks()
  handle = await createTestDatabase(); testDb = handle.db
  await testDb.insert(chatIntegrations).values({ id: 'integration', provider: 'recall', agentSlug: 'agent', config: '{}', status: 'active', createdAt: new Date(), updatedAt: new Date() }).run()
  token = mintParticipantToken()
  const meeting = await createMeeting({ integrationId: 'integration', agentSlug: 'agent', meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'google_meet', botName: 'Ada', participantToken: token, createdByUserId: 'alice' })
  meetingId = meeting.id
})
afterEach(async () => { vi.restoreAllMocks(); await handle.close() })

const url = (suffix = '', t = token) => `/api/meeting-participant/${meetingId}${suffix}?token=${encodeURIComponent(t)}`

describe('participant bootstrap', () => {
  it('refuses without the right token and before the session exists', async () => {
    expect((await app.request(`/api/meeting-participant/${meetingId}`)).status).toBe(401)
    expect((await app.request(url('', 'wrong'))).status).toBe(404)
    const early = await app.request(url())
    expect(early.status).toBe(503)
    expect(await early.json()).toMatchObject({ retryAfterMs: 2000 })
    expect(early.headers.get('Set-Cookie')).toBeNull()
  })
  it('answers with the agent session and hands the page its scoped cookie', async () => {
    await setMeetingSession(meetingId, 'session-1')
    const res = await app.request(url())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ agentSlug: 'agent', agentName: 'Ada', agentAvatar: { color: 'tonal-blue', shape: 'hexagon' }, sessionId: 'session-1', meeting: { id: meetingId, botName: 'Ada', recordingRetainedUntil: null } })
    const cookie = res.headers.get('Set-Cookie')!
    expect(cookie).toContain(`gamut_meeting_participant=${encodeURIComponent(`${meetingId}.${token}`)}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Secure')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
  it('is gone once the meeting ended', async () => {
    await setMeetingSession(meetingId, 'session-1')
    await transitionMeeting(meetingId, 'joining')
    await transitionMeeting(meetingId, 'ended')
    expect((await app.request(url())).status).toBe(410)
  })
})

describe('roster stream', () => {
  it('sends the current roster at once and each change after, and stops watching once the client is gone', async () => {
    await meetingRoster.apply(meetingId, { kind: 'join', participant: { id: '1', name: 'Iddo', isHost: true } }, 'Ada')
    const subscriptions: Subscription[] = []
    const state = appState()
    const subscribe = state.subscribe.bind(state)
    vi.spyOn(state, 'subscribe').mockImplementation((async (...args: Parameters<typeof state.subscribe>) => {
      const subscription = await subscribe(...args)
      subscriptions.push(subscription)
      vi.spyOn(subscription, 'unsubscribe')
      return subscription
    }) as typeof state.subscribe)
    const controller = new AbortController()
    const res = await app.request(url('/stream'), { signal: controller.signal })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const read = async () => decoder.decode((await reader.read()).value)
    const first = await read()
    expect(first).toContain('event: roster')
    expect(first).toContain('Iddo')
    await meetingRoster.apply(meetingId, { kind: 'join', participant: { id: '2', name: 'Maya', isHost: false } }, 'Ada')
    expect(await read()).toContain('Maya')
    expect(subscriptions).toHaveLength(1)
    controller.abort()
    await vi.waitFor(() => expect(subscriptions[0].unsubscribe).toHaveBeenCalled())
  })
  it('refuses a bad token', async () => {
    expect((await app.request(url('/stream', 'nope'))).status).toBe(404)
  })
})

describe('bot host events', () => {
  const post = (body: string, suffix = '/events/') => app.request(url(suffix), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  const recall = (event: string, participant: { id: number; name: string; is_host?: boolean }) => JSON.stringify({ event: `participant_events.${event}`, data: { data: { participant } } })
  it('applies the event to the roster on either path spelling', async () => {
    expect(await (await post(recall('join', { id: 1, name: 'Iddo', is_host: true }))).json()).toEqual({ accepted: true })
    expect(await (await post(recall('join', { id: 2, name: 'Maya' }), '/events')).json()).toEqual({ accepted: true })
    expect(await (await post(recall('speech_on', { id: 2, name: 'Maya' }))).json()).toEqual({ accepted: true })
    expect(await meetingRoster.get(meetingId)).toEqual({ participants: [{ id: '1', name: 'Iddo', isHost: true }, { id: '2', name: 'Maya', isHost: false }], speaking: ['2'] })
    expect((await appState().get(meetingSpeakersKey(meetingId)))?.value).toEqual([expect.objectContaining({ name: 'Maya' })])
  })
  it('acknowledges what it does not track, leaves the bot itself out, and refuses a bad token', async () => {
    expect(await (await post(JSON.stringify({ event: 'transcript.data', data: { data: {} } }))).json()).toEqual({ accepted: false })
    expect(await (await post(recall('join', { id: 3, name: 'Ada' }))).json()).toEqual({ accepted: true })
    expect(await (await post(recall('speech_on', { id: 3, name: 'Ada' }))).json()).toEqual({ accepted: true })
    expect((await app.request(url('/events/', 'wrong'), { method: 'POST', body: recall('join', { id: 1, name: 'Iddo' }) })).status).toBe(404)
    expect(await meetingRoster.get(meetingId)).toEqual({ participants: [], speaking: [] })
    expect(await appState().get(meetingSpeakersKey(meetingId))).toBeNull()
  })
  it('changes nothing for a meeting that has ended', async () => {
    await transitionMeeting(meetingId, 'joining')
    await transitionMeeting(meetingId, 'ended')
    expect(await (await post(recall('join', { id: 1, name: 'Iddo' }))).json()).toEqual({ accepted: true })
    expect(await meetingRoster.get(meetingId)).toEqual({ participants: [], speaking: [] })
  })
  it('rejects oversized bodies before reading them', async () => {
    const res = await post(JSON.stringify({ pad: 'x'.repeat(20 * 1024) }))
    expect(res.status).toBe(413)
  })
  it('answers unparseable JSON as not an event rather than failing the host', async () => {
    const res = await post('not json')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accepted: false })
  })
})
