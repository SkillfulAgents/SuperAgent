/**
 * session-metadata.json must never silently lose session names.
 *
 * Regression coverage for the data-loss bug-class: a non-atomic
 * read-modify-write with no serialization, plus a read that swallowed parse
 * errors into `{}` which was then written back. Under concurrent/interrupted
 * writes this permanently wiped every session name. These tests assert the three
 * properties that close it: serialized writes (no lost updates), atomic writes,
 * and fail-closed reads (a corrupt file aborts the write instead of clobbering).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

function workspaceDir(slug: string): string {
  return path.join(tmpDir, 'agents', slug, 'workspace')
}
function metadataPath(slug: string): string {
  return path.join(workspaceDir(slug), 'session-metadata.json')
}
function makeAgent(slug: string): void {
  fs.mkdirSync(workspaceDir(slug), { recursive: true })
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-meta-')))
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

describe('lost-update protection (serialized read-modify-write)', () => {
  it('preserves ALL names when many registrations race concurrently', async () => {
    const { registerSession, readSessionMetadata } = await importService()
    makeAgent('busy-agent')

    const ids = Array.from({ length: 40 }, (_, i) => `session-${i}`)
    // Fire every registration at once — the original code lost most of these.
    await Promise.all(ids.map((id) => registerSession('busy-agent', id, `Name ${id}`)))

    const meta = await readSessionMetadata('busy-agent')
    expect(Object.keys(meta).sort()).toEqual([...ids].sort())
    for (const id of ids) {
      expect(meta[id].name).toBe(`Name ${id}`)
    }
  })

  it('preserves prior names when a registration races a rename', async () => {
    const { registerSession, updateSessionName, readSessionMetadata } = await importService()
    makeAgent('agent')

    // Seed 10 existing named sessions.
    for (let i = 0; i < 10; i++) {
      await registerSession('agent', `existing-${i}`, `Existing ${i}`)
    }

    // Concurrently: register a new session AND rename several existing ones.
    await Promise.all([
      registerSession('agent', 'new-session', 'Brand New'),
      updateSessionName('agent', 'existing-0', 'Renamed 0'),
      updateSessionName('agent', 'existing-5', 'Renamed 5'),
      updateSessionName('agent', 'existing-9', 'Renamed 9'),
    ])

    const meta = await readSessionMetadata('agent')
    expect(Object.keys(meta)).toHaveLength(11)
    expect(meta['new-session'].name).toBe('Brand New')
    expect(meta['existing-0'].name).toBe('Renamed 0')
    expect(meta['existing-5'].name).toBe('Renamed 5')
    expect(meta['existing-9'].name).toBe('Renamed 9')
    expect(meta['existing-1'].name).toBe('Existing 1') // untouched survives
  })

  it('concurrent partial updates to the same session merge without dropping fields', async () => {
    const { registerSession, updateSessionMetadata, getSessionMetadata } = await importService()
    makeAgent('agent')
    await registerSession('agent', 's1', 'Original')

    await Promise.all([
      updateSessionMetadata('agent', 's1', { starred: true }),
      updateSessionMetadata('agent', 's1', { effort: 'high' }),
      updateSessionMetadata('agent', 's1', { model: 'opus' }),
    ])

    const meta = await getSessionMetadata('agent', 's1')
    expect(meta).toMatchObject({ name: 'Original', starred: true, effort: 'high', model: 'opus' })
  })
})

describe('atomic writes', () => {
  it('writes valid JSON and leaves no temp file behind', async () => {
    const { registerSession } = await importService()
    makeAgent('agent')
    await registerSession('agent', 's1', 'Session One')

    const dir = workspaceDir('agent')
    const stray = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    expect(stray).toEqual([])
    // File parses cleanly.
    expect(() => JSON.parse(fs.readFileSync(metadataPath('agent'), 'utf-8'))).not.toThrow()
  })
})

describe('fail-closed on corrupt metadata (no clobbering)', () => {
  it('registerSession THROWS and does NOT overwrite a corrupt file with a near-empty map', async () => {
    const { registerSession } = await importService()
    makeAgent('agent')
    // A torn/half-written file — the exact corruption that triggered the incident.
    const corrupt = '{ "old-session": { "name": "Precious '
    fs.writeFileSync(metadataPath('agent'), corrupt)

    await expect(registerSession('agent', 'new-session', 'New')).rejects.toThrow()

    // The corrupt bytes are still on disk — NOT replaced by `{ "new-session": ... }`.
    expect(fs.readFileSync(metadataPath('agent'), 'utf-8')).toBe(corrupt)
  })

  it('updateSessionName THROWS on corrupt file and preserves it for recovery', async () => {
    const { updateSessionName } = await importService()
    makeAgent('agent')
    const corrupt = 'not json at all'
    fs.writeFileSync(metadataPath('agent'), corrupt)

    await expect(updateSessionName('agent', 's1', 'X')).rejects.toThrow()
    expect(fs.readFileSync(metadataPath('agent'), 'utf-8')).toBe(corrupt)
  })

  it('read-only readSessionMetadata degrades to {} on corrupt WITHOUT writing', async () => {
    const { readSessionMetadata } = await importService()
    makeAgent('agent')
    const corrupt = '{ broken'
    fs.writeFileSync(metadataPath('agent'), corrupt)

    // Listing/display must not crash — it returns {} so sessions fall back to
    // auto-titles — but it must not rewrite the file.
    const meta = await readSessionMetadata('agent')
    expect(meta).toEqual({})
    expect(fs.readFileSync(metadataPath('agent'), 'utf-8')).toBe(corrupt)
  })

  it('absent file is treated as empty (not corrupt) and does not throw', async () => {
    const { readSessionMetadata, registerSession, getSessionMetadata } = await importService()
    makeAgent('agent')
    expect(await readSessionMetadata('agent')).toEqual({})
    await registerSession('agent', 's1', 'First')
    expect((await getSessionMetadata('agent', 's1'))?.name).toBe('First')
  })
})

describe('deletes preserve siblings', () => {
  it('deleteSessionsBatch only removes metadata for sessions whose JSONL it removed', async () => {
    const { registerSession, deleteSessionsBatch, readSessionMetadata } = await importService()
    makeAgent('agent')
    for (let i = 0; i < 5; i++) await registerSession('agent', `s${i}`, `S${i}`)

    // None have JSONL files on disk; deleteSessionsBatch treats missing JSONL as
    // ENOENT-deleted and drops their metadata, leaving the rest intact.
    const deleted = await deleteSessionsBatch('agent', ['s1', 's3'])
    expect(deleted.sort()).toEqual(['s1', 's3'])

    const meta = await readSessionMetadata('agent')
    expect(Object.keys(meta).sort()).toEqual(['s0', 's2', 's4'])
  })

  it('deleteSessionsBatch throws on corrupt metadata rather than rewriting it', async () => {
    const { deleteSessionsBatch } = await importService()
    makeAgent('agent')
    const corrupt = '{ "s0": { '
    fs.writeFileSync(metadataPath('agent'), corrupt)

    await expect(deleteSessionsBatch('agent', ['s0'])).rejects.toThrow()
    expect(fs.readFileSync(metadataPath('agent'), 'utf-8')).toBe(corrupt)
  })
})
