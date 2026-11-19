import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { chatIntegrations, chatIntegrationSessions } from '../db/schema'

let database: AppDatabase
let handle: TestDatabase
vi.mock('../db', () => ({ get db() { return database } }))
vi.mock('@shared/lib/db', () => ({ get db() { return database } }))

const { authenticateMeetingParticipant, participantCookieHeader, participantCookieValue, MEETING_PARTICIPANT_COOKIE } = await import('./participant-credential')
const { createMeeting, mintParticipantToken, setMeetingSession, transitionMeeting } = await import('./store')

beforeEach(async () => {
  handle = await createTestDatabase(); database = handle.db
  await database.insert(chatIntegrations).values({ id: 'integration', provider: 'recall', agentSlug: 'agent', config: '{}', status: 'active', createdAt: new Date(), updatedAt: new Date() }).run()
})
afterEach(async () => { await handle.close() })

async function meetingWithSession(overrides: { createdByUserId?: string | null } = {}) {
  const token = mintParticipantToken()
  const meeting = await createMeeting({ integrationId: 'integration', agentSlug: 'agent', meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'google_meet', botName: 'Ada', participantToken: token, createdByUserId: 'createdByUserId' in overrides ? overrides.createdByUserId : 'alice' })
  await setMeetingSession(meeting.id, 'session-1')
  return { meeting, token, cookie: `${MEETING_PARTICIPANT_COOKIE}=${encodeURIComponent(participantCookieValue(meeting.id, token))}` }
}

describe('meeting participant credential', () => {
  it('resolves the cookie to the meeting owner, scoped to the meeting agent and session', async () => {
    const { meeting, cookie } = await meetingWithSession()
    expect(await authenticateMeetingParticipant(`theme=dark; ${cookie}; other=1`)).toEqual({ meetingId: meeting.id, agentSlug: 'agent', sessionId: 'session-1', userId: 'alice' })
  })
  it('falls back to the integration session when the meeting row has not recorded one yet', async () => {
    const token = mintParticipantToken()
    const meeting = await createMeeting({ integrationId: 'integration', agentSlug: 'agent', meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'google_meet', botName: 'Ada', participantToken: token, createdByUserId: 'alice' })
    const cookie = `${MEETING_PARTICIPANT_COOKIE}=${participantCookieValue(meeting.id, token)}`
    expect(await authenticateMeetingParticipant(cookie)).toBeNull()
    await database.insert(chatIntegrationSessions).values({ id: 's', integrationId: 'integration', externalChatId: meeting.id, sessionId: 'session-2', createdAt: new Date(), updatedAt: new Date() } as never).run()
    expect((await authenticateMeetingParticipant(cookie))?.sessionId).toBe('session-2')
  })
  it('refuses a wrong token, an ended meeting, a meeting without an owner, and no cookie', async () => {
    const { meeting, cookie } = await meetingWithSession()
    expect(await authenticateMeetingParticipant(undefined)).toBeNull()
    expect(await authenticateMeetingParticipant(`${MEETING_PARTICIPANT_COOKIE}=${meeting.id}.wrong`)).toBeNull()
    expect(await authenticateMeetingParticipant(`${MEETING_PARTICIPANT_COOKIE}=garbage`)).toBeNull()
    const orphan = await meetingWithSession({ createdByUserId: null })
    expect(await authenticateMeetingParticipant(orphan.cookie)).toBeNull()
    await transitionMeeting(meeting.id, 'joining')
    await transitionMeeting(meeting.id, 'ended')
    expect(await authenticateMeetingParticipant(cookie)).toBeNull()
  })
  it('writes an http-only, same-site cookie', () => {
    expect(participantCookieHeader('m.t', { secure: true, maxAgeSeconds: 60 })).toBe(`${MEETING_PARTICIPANT_COOKIE}=m.t; Path=/; Max-Age=60; HttpOnly; SameSite=Strict; Secure`)
  })
})
