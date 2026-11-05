import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { Hono, type Context } from 'hono'
import { InMemoryFileOps } from '@shared/lib/agent-actor/testing/in-memory-file-ops'
import type { AgentActor } from '@shared/lib/agent-actor/types'

const state = vi.hoisted(() => ({
  actor: null as unknown as AgentActor, allowed: true, known: true, authMode: false,
  user: null as { id: string; name?: string } | null,
  session: null as { externalId: string; integrationId: string } | null,
  meeting: null as { id: string; agentSlug: string; integrationId: string; botName: string } | null,
}))
vi.mock('@shared/lib/agent-actor', () => ({ agentRegistry: { get: () => state.actor } }))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => state.authMode }))
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (c: Context, next: () => Promise<void>) => {
    if (state.user) c.set('user', state.user)
    return next()
  },
  ResolveAgent: () => async (_c: Context, next: () => Promise<void>) => next(),
  AgentUser: () => async (c: Context, next: () => Promise<void>) => state.allowed ? next() : c.json({ error: 'Forbidden' }, 403),
  getAgentId: () => 'ada',
}))
vi.mock('@shared/lib/agent-integrations/store', () => ({ getIntegrationSessionBySessionId: async () => state.session }))
vi.mock('@shared/lib/meeting-integrations/store', () => ({ getMeeting: async () => state.meeting }))
import { meetingSpeakerStarted } from '@shared/lib/meeting-integrations/transcript-speakers'
import router from './voice-transcripts'
const app = new Hono().route('/api/voice/agents/:id/sessions/:sessionId/transcripts', router)
const base = '/api/voice/agents/ada/sessions/s1/transcripts'
const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
let files: InMemoryFileOps
beforeEach(() => {
  state.allowed = true; state.known = true
  state.authMode = false; state.user = null; state.session = null; state.meeting = null
  files = new InMemoryFileOps()
  state.actor = { files, sessions: { isKnown: async () => state.known } } as unknown as AgentActor
})

describe('shared voice transcript routes', () => {
  it('creates a transcript in the existing session and persists a clock-adjusted speech batch before accepting', async () => {
    const id = randomUUID()
    const start = await post(base, { id })
    expect(start.status).toBe(200)
    const ref = await start.json()
    const now = Date.now()
    vi.useFakeTimers({ toFake: ['Date'], now })
    try {
      const res = await post(`${base}/${ref.index}/${id}`, { sequence: 0, sentAt: now - 2000, pieces: [{ at: now - 2500, role: 'user', text: 'Remember Friday.' }] })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ accepted: true })
      const content = new TextDecoder().decode((await files.getDoc(ref.path))!)
      expect(content).toContain(`${new Date(now - 500).toISOString().slice(0, 19).replace('T', ' ')} UTC] user: Remember Friday.`)
    } finally { vi.useRealTimers() }
  })
  it('names each shared-agent activation after its authenticated caller, ignoring client-supplied names', async () => {
    state.authMode = true
    for (const name of ['Dana', 'Sam']) {
      state.user = { id: `account-${name}`, name }
      const id = randomUUID()
      const ref = await (await post(base, { id })).json()
      const now = Date.now()
      const res = await post(`${base}/${ref.index}/${id}`, { sentAt: now, pieces: [
        { at: now, role: 'user', text: 'My request.', speaker: 'Agent owner' },
        { at: now + 100, role: 'assistant', text: 'Of course.' },
      ] })
      expect(res.status).toBe(200)
      const content = new TextDecoder().decode((await files.getDoc(ref.path))!)
      expect(content).toContain(`UTC] ${name}: My request.`)
      expect(content).toContain('UTC] Assistant: Of course.')
      expect(content).not.toContain('Agent owner')
    }
  })
  it('uses user in non-auth mode even if a user context is present', async () => {
    state.user = { id: 'local', name: 'Local owner' }
    const ref = await (await post(base, { id: randomUUID() })).json()
    const now = Date.now()
    const res = await post(`${base}/${ref.index}/${ref.id}`, { sentAt: now, pieces: [{ at: now, role: 'user', text: 'Hello.' }] })
    expect(res.status).toBe(200)
    expect(new TextDecoder().decode((await files.getDoc(ref.path))!)).toContain('UTC] user: Hello.')
  })
  it('keeps an authenticated account identifiable when its display name is empty', async () => {
    state.authMode = true
    state.user = { id: 'account-123', name: '  ' }
    const ref = await (await post(base, { id: randomUUID() })).json()
    const now = Date.now()
    const res = await post(`${base}/${ref.index}/${ref.id}`, { sentAt: now, pieces: [{ at: now, role: 'user', text: 'Hello.' }] })
    expect(res.status).toBe(200)
    expect(new TextDecoder().decode((await files.getDoc(ref.path))!)).toContain('UTC] account-123: Hello.')
  })
  it('uses meeting speakers and the bot name instead of the participant credential account', async () => {
    state.authMode = true
    state.user = { id: 'meeting-initiator' }
    state.session = { externalId: 'm1', integrationId: 'i1' }
    state.meeting = { id: 'm1', agentSlug: 'ada', integrationId: 'i1', botName: 'Ada (Gamut)' }
    const ref = await (await post(base, { id: randomUUID() })).json()
    const now = Date.now()
    await meetingSpeakerStarted('m1', 'Dana', now)
    const res = await post(`${base}/${ref.index}/${ref.id}`, { sentAt: now, pieces: [
      { at: now, role: 'user', text: 'Meeting question.' },
      { at: now + 100, role: 'assistant', text: 'Meeting answer.' },
    ] })
    expect(res.status).toBe(200)
    const content = new TextDecoder().decode((await files.getDoc(ref.path))!)
    expect(content).toContain('UTC] Dana: Meeting question.')
    expect(content).toContain('UTC] Ada (Gamut): Meeting answer.')
    expect(content).not.toContain('meeting-initiator')
  })
  it('requires an authorized existing session and refuses malformed or unallocated writes', async () => {
    state.allowed = false
    expect((await post(base, { id: randomUUID() })).status).toBe(403)
    state.allowed = true; state.known = false
    expect((await post(base, { id: randomUUID() })).status).toBe(404)
    state.known = true
    expect((await post(base, { id: '../escape' })).status).toBe(400)
    expect((await post(`${base}/0/${randomUUID()}`, { sequence: 0, sentAt: Date.now(), pieces: [{ at: Date.now(), role: 'system', text: 'Bad role' }] })).status).toBe(400)
    expect((await post(`${base}/0/${randomUUID()}`, { sequence: 0, sentAt: Date.now(), pieces: [{ at: Date.now(), role: 'user', text: 'No activation' }] })).status).toBe(404)
  })
  it('does not acknowledge speech when workspace storage fails', async () => {
    const id = randomUUID()
    const ref = await (await post(base, { id })).json()
    vi.spyOn(files, 'append').mockRejectedValueOnce(new Error('storage unavailable'))
    const res = await post(`${base}/${ref.index}/${id}`, { sequence: 0, sentAt: Date.now(), pieces: [{ at: Date.now(), role: 'user', text: 'Keep this for retry' }] })
    expect(res.status).toBe(500)
  })
})
