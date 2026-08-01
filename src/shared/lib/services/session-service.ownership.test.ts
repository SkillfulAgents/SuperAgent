/**
 * Session ownership: a session id only ever "belongs to" the agent that owns it.
 *
 * The process-global registries keyed by session id alone (the message
 * persister, above all) have no agent dimension, so any route that reaches them
 * has to establish ownership itself. `sessionIsKnown` is that check, and
 * these tests pin the three properties it has to hold:
 *
 *   1. a session of ANOTHER agent never passes;
 *   2. a session that exists only on disk, or only in metadata, still passes
 *      (the two halves are written at different times);
 *   3. an id that isn't a real key — an inherited `Object.prototype` name, or a
 *      path that escapes the agent's session directory — never passes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

function workspaceDir(slug: string): string {
  return path.join(tmpDir, 'agents', slug, 'workspace')
}
function sessionsDir(slug: string): string {
  return path.join(workspaceDir(slug), '.claude', 'projects', '-workspace')
}
function makeAgent(slug: string): void {
  fs.mkdirSync(sessionsDir(slug), { recursive: true })
}
function writeTranscript(slug: string, sessionId: string): void {
  fs.writeFileSync(path.join(sessionsDir(slug), `${sessionId}.jsonl`), '{}\n')
}
function writeMetadata(slug: string, metadata: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(workspaceDir(slug), 'session-metadata.json'),
    JSON.stringify(metadata),
  )
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-own-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.SUPERAGENT_DATA_DIR
  vi.restoreAllMocks()
})

async function importService() {
  return import('./session-service')
}

// Names inherited from Object.prototype. A membership test written with `in`
// (or a truthiness test on a bare index read) answers "yes" for every one of
// them, which turns an ownership gate into a no-op for these ids.
const INHERITED_KEYS = [
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
]

describe('isSessionRegistered', () => {
  it('is true only for a session actually registered for that agent', async () => {
    const { registerSession, isSessionRegistered } = await importService()
    makeAgent('agent-a')
    makeAgent('agent-b')
    await registerSession('agent-a', 'session-a', 'A')
    await registerSession('agent-b', 'session-b', 'B')

    expect(await isSessionRegistered('agent-a', 'session-a')).toBe(true)
    expect(await isSessionRegistered('agent-a', 'session-b')).toBe(false)
    expect(await isSessionRegistered('agent-b', 'session-a')).toBe(false)
  })

  it.each(INHERITED_KEYS)('is false for the inherited key %s', async (key) => {
    const { registerSession, isSessionRegistered } = await importService()
    makeAgent('agent-a')
    await registerSession('agent-a', 'session-a', 'A')

    expect(await isSessionRegistered('agent-a', key)).toBe(false)
  })

  it('is false for inherited keys even when the agent has no metadata at all', async () => {
    const { isSessionRegistered } = await importService()
    makeAgent('empty-agent')

    expect(await isSessionRegistered('empty-agent', 'constructor')).toBe(false)
  })
})

describe('getSessionMetadata', () => {
  it.each(INHERITED_KEYS)('returns null for the inherited key %s', async (key) => {
    const { registerSession, getSessionMetadata } = await importService()
    makeAgent('agent-a')
    await registerSession('agent-a', 'session-a', 'A')

    expect(await getSessionMetadata('agent-a', key)).toBeNull()
  })
})

describe('sessionIsKnown', () => {
  it('accepts a session with a transcript but no metadata entry', async () => {
    const { sessionIsKnown } = await importService()
    makeAgent('agent-a')
    writeTranscript('agent-a', 'on-disk-only')

    expect(await sessionIsKnown('agent-a', 'on-disk-only')).toBe(true)
  })

  it('accepts a just-registered session whose transcript does not exist yet', async () => {
    const { registerSession, sessionIsKnown } = await importService()
    makeAgent('agent-a')
    await registerSession('agent-a', 'brand-new', 'New Session')

    expect(await sessionIsKnown('agent-a', 'brand-new')).toBe(true)
  })

  it('rejects another agent’s session, by transcript or by metadata', async () => {
    const { registerSession, sessionIsKnown } = await importService()
    makeAgent('agent-a')
    makeAgent('agent-b')
    writeTranscript('agent-b', 'b-on-disk')
    await registerSession('agent-b', 'b-registered', 'B')

    expect(await sessionIsKnown('agent-a', 'b-on-disk')).toBe(false)
    expect(await sessionIsKnown('agent-a', 'b-registered')).toBe(false)
  })

  it('rejects a forged duplicate transcript in an agent-writable workspace', async () => {
    const { sessionIsKnown } = await importService()
    makeAgent('agent-a')
    makeAgent('agent-b')
    writeTranscript('agent-b', 'victim-session')

    // Initialize and persist the host-owned owner before the attacker writes a
    // same-named file into its own bind-mounted workspace.
    expect(await sessionIsKnown('agent-b', 'victim-session')).toBe(true)
    writeTranscript('agent-a', 'victim-session')

    expect(await sessionIsKnown('agent-a', 'victim-session')).toBe(false)
    expect(await sessionIsKnown('agent-b', 'victim-session')).toBe(true)
    expect(
      JSON.parse(fs.readFileSync(path.join(tmpDir, 'session-ownership.json'), 'utf-8')),
    ).toEqual({ 'victim-session': 'agent-b' })
  })

  it('fails closed when duplicate transcripts predate ownership migration', async () => {
    const { sessionIsKnown } = await importService()
    makeAgent('agent-a')
    makeAgent('agent-b')
    writeTranscript('agent-a', 'duplicate-session')
    writeTranscript('agent-b', 'duplicate-session')

    expect(await sessionIsKnown('agent-a', 'duplicate-session')).toBe(false)
    expect(await sessionIsKnown('agent-b', 'duplicate-session')).toBe(false)
    expect(
      JSON.parse(fs.readFileSync(path.join(tmpDir, 'session-ownership.json'), 'utf-8')),
    ).toEqual({ 'duplicate-session': null })
  })

  it('rejects forged metadata for a session registered to another agent', async () => {
    const { registerSession, sessionIsKnown } = await importService()
    makeAgent('agent-a')
    makeAgent('agent-b')
    await registerSession('agent-b', 'victim-session', 'Victim')
    writeMetadata('agent-a', {
      'victim-session': { name: 'Forged', createdAt: new Date().toISOString() },
    })

    expect(await sessionIsKnown('agent-a', 'victim-session')).toBe(false)
    expect(await sessionIsKnown('agent-b', 'victim-session')).toBe(true)
  })

  it('does not discover forged ids after the one-time legacy migration', async () => {
    const { sessionIsKnown } = await importService()
    makeAgent('agent-a')

    expect(await sessionIsKnown('agent-a', 'missing-before-migration')).toBe(false)
    writeTranscript('agent-a', 'forged-after-migration')

    expect(await sessionIsKnown('agent-a', 'forged-after-migration')).toBe(false)
  })

  it('reserves a new id before either workspace contains its transcript', async () => {
    const { reserveSessionOwnership, sessionIsKnown } = await importService()
    makeAgent('agent-a')
    makeAgent('agent-b')

    await reserveSessionOwnership('agent-b', 'future-session')
    writeTranscript('agent-a', 'future-session')
    writeTranscript('agent-b', 'future-session')

    expect(await sessionIsKnown('agent-a', 'future-session')).toBe(false)
    expect(await sessionIsKnown('agent-b', 'future-session')).toBe(true)
  })

  it('rejects an unknown session id', async () => {
    const { sessionIsKnown } = await importService()
    makeAgent('agent-a')

    expect(await sessionIsKnown('agent-a', 'never-existed')).toBe(false)
  })

  it.each(INHERITED_KEYS)('rejects the inherited key %s', async (key) => {
    const { registerSession, sessionIsKnown } = await importService()
    makeAgent('agent-a')
    await registerSession('agent-a', 'session-a', 'A')

    expect(await sessionIsKnown('agent-a', key)).toBe(false)
  })

  it('rejects — without throwing — an id that escapes the agent’s session directory', async () => {
    const { sessionIsKnown } = await importService()
    makeAgent('agent-a')
    makeAgent('agent-b')
    writeTranscript('agent-b', 'b-session')

    // Resolves onto agent-b's real transcript. A raw sessionExists() call throws
    // 'Invalid session ID' here; the gate has to answer false, because a caller
    // that lets the throw escape hands the request to whatever its catch does.
    const escaping = '../../../../../agent-b/workspace/.claude/projects/-workspace/b-session'
    await expect(sessionIsKnown('agent-a', escaping)).resolves.toBe(false)
  })

  it('rejects a bare traversal id without throwing', async () => {
    const { sessionIsKnown } = await importService()
    makeAgent('agent-a')

    await expect(sessionIsKnown('agent-a', '../../../etc/passwd')).resolves.toBe(false)
  })
})
