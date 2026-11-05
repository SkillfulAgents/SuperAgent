import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { Hono, type Context } from 'hono'
import { InMemoryFileOps } from '@shared/lib/agent-actor/testing/in-memory-file-ops'
import type { AgentActor } from '@shared/lib/agent-actor/types'

const state = vi.hoisted(() => ({ actor: null as unknown as AgentActor, allowed: true, known: true }))
vi.mock('@shared/lib/agent-actor', () => ({ agentRegistry: { get: () => state.actor } }))
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: Context, next: () => Promise<void>) => next(),
  ResolveAgent: () => async (_c: Context, next: () => Promise<void>) => next(),
  AgentUser: () => async (c: Context, next: () => Promise<void>) => state.allowed ? next() : c.json({ error: 'Forbidden' }, 403),
  getAgentId: () => 'ada',
}))
vi.mock('@shared/lib/meeting-integrations/transcript-speakers', () => ({
  nameVoiceSpeech: async (_agent: string, _session: string, pieces: Array<{ role: string }>) => pieces.map(piece => ({ ...piece, speaker: piece.role === 'assistant' ? 'Assistant' : 'User' })),
}))
import router from './voice-transcripts'
const app = new Hono().route('/api/voice/agents/:id/sessions/:sessionId/transcripts', router)
const base = '/api/voice/agents/ada/sessions/s1/transcripts'
const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
let files: InMemoryFileOps
beforeEach(() => {
  state.allowed = true; state.known = true
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
      expect(content).toContain(`${new Date(now - 500).toISOString().slice(0, 19).replace('T', ' ')} UTC] User: Remember Friday.`)
    } finally { vi.useRealTimers() }
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
