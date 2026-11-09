// A container keeps a session's CLI process after its last turn, and the CLI appends to the
// transcript on exit, creating the file again. A transcript without metadata lists as "New Session".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('@shared/lib/agent-actor/db-session-index-storage', async () =>
  (await import('@shared/lib/agent-actor/testing/in-memory-session-index-storage')).inMemorySessionIndexModule())
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => ({}),
}))
vi.mock('@shared/lib/services/session-activity', () => ({
  recordSessionActivity: vi.fn(),
  recordProvisionalSessionActivity: (_store: unknown, _id: string, at: number) => ({ recordedAtMs: at, previousMs: null }),
  revertSessionActivity: vi.fn(),
}))

import * as sessionService from '@shared/lib/services/session-service'
import { LocalAgentActor, type LocalActorDeps } from './local-agent-actor'
import { CLI_TRANSCRIPTS_DIR } from './session-store'
import { createRecordingHostPort } from './testing/recording-host-port'

const SESSION = '0b6f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4'
const OTHER = '1c7a2e3f-4d5b-4c6d-9e7f-8091a2b3c4d5'
const THIRD = '2d8b3f40-5e6c-4d7e-af80-91a2b3c4d5e6'

let workspace: string
const transcriptFile = (id: string) => path.join(workspace, CLI_TRANSCRIPTS_DIR, `${id}.jsonl`)
const exitWrite = (id: string) =>
  fs.appendFileSync(transcriptFile(id), JSON.stringify({ type: 'last-prompt', lastPrompt: 'hi', sessionId: id }) + '\n')

// Sessions whose CLI process is still alive in the container.
const resident = new Set<string>()
let status: 'running' | 'stopped'
const client = {
  releaseSession: vi.fn(async (id: string) => {
    if (status !== 'running') throw new Error('Container is not running')
    if (resident.delete(id)) exitWrite(id)
    return true
  }),
  deleteSession: vi.fn(async (_id: string) => true),
  isDefinitelyStopped: vi.fn(async () => status === 'stopped'),
  getInfoFromRuntime: vi.fn(async () => ({ status, port: status === 'running' ? 4321 : null })),
}
// The container's idle sweep stops every resident process.
const evictIdle = () => {
  for (const id of resident) exitWrite(id)
  resident.clear()
}

const deps = () =>
  ({
    containerHost: {
      runtime: () => ({
        getClient: () => client,
        getCachedInfo: () => ({ status, port: 4321 }),
        noteSessionActivity: vi.fn(),
      }),
    },
    host: createRecordingHostPort().port,
    sessionService,
    getAgentWorkspaceDir: () => workspace,
    recordSessionActivity: vi.fn(),
  }) as unknown as LocalActorDeps

const listed = async (actor: LocalAgentActor) => (await sessionService.listSessions(actor.store)).map((s) => s.id)

async function seed(actor: LocalAgentActor, id: string) {
  await sessionService.registerSession(actor.store, id, 'Greeting')
  fs.writeFileSync(
    transcriptFile(id),
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId: id, message: { role: 'user', content: 'hi' } }) + '\n',
  )
  resident.add(id)
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'session-delete-'))
  fs.mkdirSync(path.dirname(transcriptFile(SESSION)), { recursive: true })
  resident.clear()
  status = 'running'
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(workspace, { recursive: true, force: true })
})

describe('deleting a session', () => {
  it.each(['single', 'batch'])('keeps the resume record when %s file deletion fails', async (mode) => {
    const actor = new LocalAgentActor('agent', deps())
    await seed(actor, SESSION)
    vi.spyOn(actor.store.files, 'delete').mockRejectedValueOnce(new Error('EACCES'))

    if (mode === 'single') await expect(actor.sessions.delete(SESSION)).rejects.toThrow('EACCES')
    else expect(await actor.sessions.deleteMany([SESSION])).toEqual([])

    expect(await listed(actor)).toEqual([SESSION])
    expect(client.releaseSession).toHaveBeenCalledWith(SESSION)
    expect(client.deleteSession).not.toHaveBeenCalled()
  })

  it('keeps the resume record when the release response is lost', async () => {
    const actor = new LocalAgentActor('agent', deps())
    await seed(actor, SESSION)
    client.releaseSession.mockImplementationOnce(async (id) => {
      resident.delete(id)
      exitWrite(id)
      throw new Error('response lost')
    })
    await expect(actor.sessions.delete(SESSION)).rejects.toThrow('Container did not drop')
    expect(await listed(actor)).toEqual([SESSION])
    expect(client.deleteSession).not.toHaveBeenCalled()
  })

  it.each(['unready', 'terminating', 'unknown'])('keeps files when routing says stopped but the process is %s', async () => {
    const actor = new LocalAgentActor('agent', deps())
    await seed(actor, SESSION)
    status = 'stopped'
    client.isDefinitelyStopped.mockResolvedValueOnce(false)
    await expect(actor.sessions.delete(SESSION)).rejects.toThrow('Container did not drop')
    expect(await listed(actor)).toEqual([SESSION])
    expect(client.getInfoFromRuntime).not.toHaveBeenCalled()
  })

  it('reports success when only the final resume-record cleanup fails', async () => {
    const actor = new LocalAgentActor('agent', deps())
    await seed(actor, SESSION)
    client.deleteSession.mockRejectedValueOnce(new Error('response lost'))
    expect(await actor.sessions.delete(SESSION)).toBe(true)
    expect(await listed(actor)).toEqual([])
  })

  it.each(['single', 'batch'])('holds new sends until the %s file deletion finishes', async (mode) => {
    const actor = new LocalAgentActor('agent', deps())
    await seed(actor, SESSION)
    let finish!: () => void
    const held = new Promise<void>((resolve) => { finish = resolve })
    const remove = actor.store.files.delete.bind(actor.store.files)
    vi.spyOn(actor.store.files, 'delete').mockImplementationOnce(async (file) => {
      await held
      return remove(file)
    })
    const deleting = mode === 'single' ? actor.sessions.delete(SESSION) : actor.sessions.deleteMany([SESSION])
    await vi.waitFor(() => expect(actor.store.files.delete).toHaveBeenCalled())
    const sent = vi.fn(async () => expect(await actor.sessions.exists(SESSION)).toBe(false))
    const sending = actor.state.sessions.inDeliveryTurn(SESSION, sent)
    await Promise.resolve()
    expect(sent).not.toHaveBeenCalled()
    finish()
    await Promise.all([deleting, sending])
    expect(sent).toHaveBeenCalledOnce()
  })

  it('stays deleted after the container would have stopped its process', async () => {
    const actor = new LocalAgentActor('agent', deps())
    await seed(actor, SESSION)

    expect(await actor.sessions.delete(SESSION)).toBe(true)
    evictIdle()

    expect(await listed(actor)).toEqual([])
    expect(fs.existsSync(transcriptFile(SESSION))).toBe(false)
  })

  it('deletes when the container is not running', async () => {
    const actor = new LocalAgentActor('agent', deps())
    await seed(actor, SESSION)
    resident.clear()
    status = 'stopped'

    expect(await actor.sessions.delete(SESSION)).toBe(true)
    expect(await listed(actor)).toEqual([])
  })

  it('keeps the session when a running container does not drop it', async () => {
    const actor = new LocalAgentActor('agent', deps())
    await seed(actor, SESSION)
    client.releaseSession.mockRejectedValueOnce(new Error('timeout'))

    await expect(actor.sessions.delete(SESSION)).rejects.toThrow()
    expect(await listed(actor)).toEqual([SESSION])
    // Its live state went with the attempt; the next send attaches again.
    expect(actor.state.sessions.isSubscribed(SESSION)).toBe(false)
  })

  it('auto-delete removes only the sessions the container dropped', async () => {
    const actor = new LocalAgentActor('agent', deps())
    for (const id of [SESSION, OTHER, THIRD]) await seed(actor, id)
    client.releaseSession.mockImplementationOnce(async () => true).mockImplementationOnce(async () => false)

    expect(await actor.sessions.deleteMany([OTHER, SESSION, THIRD])).toEqual([OTHER, THIRD])
    expect(await listed(actor)).toEqual([SESSION])
  })

  it('auto-delete skips a session that turns active while an earlier one is released', async () => {
    const actor = new LocalAgentActor('agent', deps())
    await seed(actor, SESSION)
    await seed(actor, OTHER)
    client.releaseSession.mockImplementationOnce(async () => {
      actor.state.sessions.markActive(OTHER)
      return true
    })

    expect(await actor.sessions.deleteMany([SESSION, OTHER])).toEqual([SESSION])
    expect(client.releaseSession).toHaveBeenCalledTimes(1)
    expect(await listed(actor)).toEqual([OTHER])
  })
})
