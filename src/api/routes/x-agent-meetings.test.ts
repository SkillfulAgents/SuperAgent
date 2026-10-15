import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { IntegrationPolicyError } from '@shared/lib/agent-integrations/errors'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: async (token: string) => (token === 'agent-token' ? 'agent' : token === 'other-token' ? 'other' : null) }))
const host = vi.hoisted(() => ({ internet: 'https://app.example' as string | null, botService: true }))
vi.mock('@shared/lib/agent-integrations/app-link', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/agent-integrations/app-link')>(),
  resolvePublicAppBaseUrl: () => 'https://app.example',
  resolveInternetAppBaseUrl: () => host.internet,
}))
vi.mock('@shared/lib/meeting-integrations/recall/transport', () => ({ resolveRecallTransport: () => (host.botService ? { kind: 'test' } : null) }))
// The family's tools, as the connector would hand them out; the route must reach them and nothing else.
const tools = vi.hoisted(() => ({
  join: vi.fn(async (_input: unknown, _invocation: unknown) => ({ id: 'meeting-1', status: 'requested' })),
  leave: vi.fn(async (_input: unknown) => ({ id: 'meeting-1', status: 'ended' })),
  chat: vi.fn(async (_input: unknown) => ({ sent: true })),
  recording: vi.fn(async () => ({ url: 'https://recording' })),
  connected: true,
  joinExposure: 'both' as 'both' | 'management',
}))
const manager = vi.hoisted(() => ({ addIntegration: vi.fn(async () => {}), integrationCreated: vi.fn(async () => {}) }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: {
  addIntegration: (...args: unknown[]) => manager.addIntegration(...(args as [])),
  integrationCreated: (...args: unknown[]) => manager.integrationCreated(...(args as [])),
  getConnector: () => (tools.connected ? { getTools: () => [
    { name: 'join_meeting', exposure: tools.joinExposure, description: '', inputSchema: {}, execute: tools.join },
    { name: 'leave_meeting', exposure: 'both', description: '', inputSchema: {}, execute: tools.leave },
    { name: 'send_meeting_chat', exposure: 'both', description: '', inputSchema: {}, execute: tools.chat },
    { name: 'get_meeting_recording', exposure: 'management', description: '', inputSchema: {}, execute: tools.recording },
  ] } : undefined),
} }))

const { createAgentIntegration, listAgentIntegrations, updateAgentIntegrationStatus } = await import('@shared/lib/services/agent-integration-service')
const { createMeeting, mintParticipantToken } = await import('@shared/lib/meeting-integrations/store')
const { default: router } = await import('./x-agent-meetings')
const app = new Hono().route('/api/x-agent/meetings', router)

const post = (op: string, body: unknown, token = 'agent-token') => app.request(`/api/x-agent/meetings/${op}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
})
const meetingIntegrations = async (slug = 'agent') => (await listAgentIntegrations(slug)).filter(row => row.provider === 'recall')

beforeEach(async () => {
  vi.clearAllMocks()
  host.internet = 'https://app.example'; host.botService = true; tools.connected = true; tools.joinExposure = 'both'
  handle = await createTestDatabase(); testDb = handle.db
})
afterEach(async () => { await handle.close() })

describe('authentication', () => {
  it('refuses without the agent token', async () => {
    expect((await app.request('/api/x-agent/meetings/list', { method: 'POST' })).status).toBe(401)
    expect((await post('list', {}, 'stale')).status).toBe(401)
  })
})

describe('join', () => {
  it('sets the meeting integration up on first use, then runs the family join as the agent', async () => {
    const res = await post('join', { meeting_url: 'https://zoom.us/j/123?pwd=abc', context: 'Take notes', mode: 'listen' })
    expect(res.status).toBe(200)
    const rows = await meetingIntegrations()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agentSlug: 'agent', provider: 'recall', name: 'Meetings', status: 'active', createdByUserId: null })
    expect(manager.addIntegration).toHaveBeenCalledWith(rows[0].id)
    expect(manager.integrationCreated).toHaveBeenCalledWith(rows[0].id)
    expect(tools.join).toHaveBeenCalledWith({ meetingUrl: 'https://zoom.us/j/123?pwd=abc', context: 'Take notes', mode: 'listen' }, { source: 'agent' })
    expect(await res.json()).toEqual({ meeting: { id: 'meeting-1', status: 'requested' }, integrationId: rows[0].id, integrationCreated: true })
  })
  it('reuses the installation it has instead of making another', async () => {
    const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'recall', config: {}, createdByUserId: 'alice' })
    const res = await post('join', { meeting_url: 'https://meet.google.com/abc-defg-hij' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ integrationId: id, integrationCreated: false })
    expect(await meetingIntegrations()).toHaveLength(1)
    expect(manager.integrationCreated).not.toHaveBeenCalled()
    expect(tools.join).toHaveBeenCalledWith({ meetingUrl: 'https://meet.google.com/abc-defg-hij', context: undefined, mode: undefined }, { source: 'agent' })
  })
  it('does not set anything up on a host that cannot run meeting bots', async () => {
    host.botService = false
    const noBots = await post('join', { meeting_url: 'https://zoom.us/j/123' })
    expect(noBots.status).toBe(400)
    expect(await noBots.json()).toEqual({ error: 'Meetings are unavailable on this host: it needs a public https address (HOST_PUBLIC_URL) and a Platform connection or a Recall.ai key.' })
    host.botService = true; host.internet = null
    expect((await post('join', { meeting_url: 'https://zoom.us/j/123' })).status).toBe(400)
    expect(await meetingIntegrations()).toHaveLength(0)
    expect(tools.join).not.toHaveBeenCalled()
  })
  it('respects a paused installation rather than working around it', async () => {
    const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'recall', config: {} })
    await updateAgentIntegrationStatus(id, 'paused')
    const res = await post('join', { meeting_url: 'https://zoom.us/j/123' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/paused/)
    expect(await meetingIntegrations()).toHaveLength(1)
    expect(tools.join).not.toHaveBeenCalled()
  })
  it('passes the family refusal on as something the agent can act on, and reports a fault otherwise', async () => {
    tools.join.mockRejectedValueOnce(new IntegrationPolicyError('That does not look like a Zoom, Google Meet or Microsoft Teams invite link.'))
    const refused = await post('join', { meeting_url: 'https://example.com/not-a-meeting' })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ error: 'That does not look like a Zoom, Google Meet or Microsoft Teams invite link.' })
    tools.join.mockRejectedValueOnce(new Error('bot host down'))
    expect((await post('join', { meeting_url: 'https://zoom.us/j/123' })).status).toBe(500)
  })
  it('validates its input and refuses when the installation cannot be connected', async () => {
    expect((await post('join', { meeting_url: '' })).status).toBe(400)
    expect((await post('join', { meeting_url: 'https://zoom.us/j/1', mode: 'loud' })).status).toBe(400)
    tools.connected = false
    const res = await post('join', { meeting_url: 'https://zoom.us/j/123' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'The meeting integration is not connected.' })
  })
})

describe('leave, chat and list', () => {
  let integrationId: string
  let meetingId: string
  beforeEach(async () => {
    integrationId = await createAgentIntegration({ agentSlug: 'agent', provider: 'recall', config: {} })
    await createMeeting({ integrationId, agentSlug: 'agent', meetingUrl: 'https://zoom.us/j/1', platform: 'zoom', botName: 'Ada', participantToken: mintParticipantToken() })
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await createMeeting({ integrationId, agentSlug: 'agent', meetingUrl: 'https://zoom.us/j/2', platform: 'zoom', botName: 'Ada', participantToken: mintParticipantToken() })
    meetingId = second.id
  })
  it('leaves only the caller\'s own meeting', async () => {
    const res = await post('leave', { meeting_id: meetingId })
    expect(res.status).toBe(200)
    expect(tools.leave).toHaveBeenCalledWith({ meetingId }, { source: 'agent' })
    expect(await res.json()).toEqual({ meeting: { id: 'meeting-1', status: 'ended' } })
    const other = await post('leave', { meeting_id: meetingId }, 'other-token')
    expect(other.status).toBe(400)
    expect(await other.json()).toEqual({ error: 'Unknown meeting.' })
    expect(tools.leave).toHaveBeenCalledTimes(1)
  })
  it('posts into a meeting chat, by meeting or into the one live call', async () => {
    expect((await post('chat', { meeting_id: meetingId, message: 'https://doc' })).status).toBe(200)
    expect(tools.chat).toHaveBeenLastCalledWith({ meetingId, message: 'https://doc' }, { source: 'agent' })
    expect((await post('chat', { message: 'hello' })).status).toBe(200)
    expect(tools.chat).toHaveBeenLastCalledWith({ meetingId: undefined, message: 'hello' }, { source: 'agent' })
    const nobody = await post('chat', { message: 'hello' }, 'other-token')
    expect(nobody.status).toBe(400)
    expect(await nobody.json()).toEqual({ error: 'This agent has no meeting integration.' })
  })
  it('never runs a tool the family keeps for people', async () => {
    tools.joinExposure = 'management'
    const res = await post('join', { meeting_url: 'https://zoom.us/j/123' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'The recall provider does not support join_meeting.' })
    expect(tools.join).not.toHaveBeenCalled()
  })
  it('lists the caller\'s meetings newest first, from the store', async () => {
    const res = await post('list', {})
    expect(res.status).toBe(200)
    const { meetings } = await res.json() as { meetings: Array<{ id: string; meetingUrl: string }> }
    expect(meetings.map(meeting => meeting.meetingUrl)).toEqual(['https://zoom.us/j/2', 'https://zoom.us/j/1'])
    expect(meetings[0]).toMatchObject({ id: meetingId, integrationId, status: 'requested' })
    const limited = await post('list', { limit: 1 })
    expect(((await limited.json()) as { meetings: unknown[] }).meetings).toHaveLength(1)
    expect(((await (await post('list', {}, 'other-token')).json()) as { meetings: unknown[] }).meetings).toEqual([])
  })
})
