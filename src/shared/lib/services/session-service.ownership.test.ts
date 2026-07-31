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
