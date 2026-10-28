import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { chatIntegrations } from '@shared/lib/db/schema'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('@shared/lib/agent-actor', () => ({ agentCatalog: { get: vi.fn(async () => ({ slug: 'agent', name: 'Ada' })) } }))
const connector = vi.hoisted(() => ({ value: null as null | { receiveBotEvent: ReturnType<typeof vi.fn> } }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: { getConnector: () => connector.value } }))
// The route recognizes the family's connector by class; the fake must be one.
vi.mock('@shared/lib/meeting-integrations/meeting-agent-integration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/meeting-integrations/meeting-agent-integration')>()
  return { ...actual, MeetingAgentIntegration: class { receiveBotEvent = (meetingId: string, body: unknown) => (connector.value!.receiveBotEvent as (m: string, b: unknown) => Promise<boolean>)(meetingId, body) } }
})

const { createMeeting, mintParticipantToken, setMeetingSession, transitionMeeting } = await import('@shared/lib/meeting-integrations/store')
const { meetingRoster } = await import('@shared/lib/meeting-integrations/roster')
const { MeetingAgentIntegration } = await import('@shared/lib/meeting-integrations/meeting-agent-integration')
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
  const fake = new (MeetingAgentIntegration as unknown as new () => { receiveBotEvent: ReturnType<typeof vi.fn> })()
  connector.value = Object.assign(fake, { receiveBotEvent: vi.fn(async () => true) })
})
afterEach(async () => { await handle.close() })

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
    expect(await res.json()).toMatchObject({ agentSlug: 'agent', agentName: 'Ada', sessionId: 'session-1', meeting: { id: meetingId, botName: 'Ada', recordingRetainedUntil: null } })
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
  it('sends the current roster at once and each change after', async () => {
    meetingRoster.apply(meetingId, { kind: 'join', participant: { id: '1', name: 'Iddo', isHost: true } }, 'Ada')
    const controller = new AbortController()
    const res = await app.request(url('/stream'), { signal: controller.signal })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const read = async () => decoder.decode((await reader.read()).value)
    expect(await read()).toContain('event: roster')
    meetingRoster.apply(meetingId, { kind: 'join', participant: { id: '2', name: 'Maya', isHost: false } }, 'Ada')
    expect(await read()).toContain('Maya')
    controller.abort()
    meetingRoster.clear(meetingId)
  })
  it('refuses a bad token', async () => {
    expect((await app.request(url('/stream', 'nope'))).status).toBe(404)
  })
})

describe('bot host events', () => {
  const post = (body: string, suffix = '/events/') => app.request(url(suffix), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  it('hands the parsed body to the connector on either path spelling', async () => {
    const event = JSON.stringify({ event: 'participant_events.join', data: { data: { participant: { id: 1, name: 'Iddo' } } } })
    expect(await (await post(event)).json()).toEqual({ accepted: true })
    expect(await (await post(event, '/events')).json()).toEqual({ accepted: true })
    expect(connector.value!.receiveBotEvent).toHaveBeenCalledWith(meetingId, JSON.parse(event))
  })
  it('acknowledges with accepted:false when the connector is not running, and refuses a bad token', async () => {
    connector.value = null
    expect(await (await post('{}')).json()).toEqual({ accepted: false, reason: 'integration not connected' })
    expect((await app.request(url('/events/', 'wrong'), { method: 'POST', body: '{}' })).status).toBe(404)
  })
  it('rejects oversized bodies before reading them into the connector', async () => {
    const res = await post(JSON.stringify({ pad: 'x'.repeat(20 * 1024) }))
    expect(res.status).toBe(413)
    expect(connector.value!.receiveBotEvent).not.toHaveBeenCalled()
  })
  it('passes unparseable JSON through as null rather than failing the host', async () => {
    expect(await (await post('not json')).json()).toEqual({ accepted: true })
    expect(connector.value!.receiveBotEvent).toHaveBeenCalledWith(meetingId, null)
  })
})
