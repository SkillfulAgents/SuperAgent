/**
 * mounts.json must fail closed (stop swallowing parse/IO into `[]`)
 * and write atomically, so a transiently-unreadable file can't make the next
 * addMount persist only the new mount and drop every prior one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { CorruptFileError } from '@shared/lib/utils/file-storage'

let tmpDir: string

function mountsPath(slug: string): string {
  return path.join(tmpDir, 'agents', slug, 'mounts.json')
}
function makeAgentDir(slug: string): void {
  fs.mkdirSync(path.join(tmpDir, 'agents', slug), { recursive: true })
}
function makeHostDir(name: string): string {
  const dir = path.join(tmpDir, 'host', name)
  fs.mkdirSync(dir, { recursive: true })
  return fs.realpathSync(dir)
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mount-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.SUPERAGENT_DATA_DIR
})

async function importService() {
  return import('./mount-service')
}

describe('mounts.json reads — tolerant display, fail-closed writes', () => {
  it('absent file → [] (legitimate "no mounts yet")', async () => {
    const { getMounts } = await importService()
    makeAgentDir('agent')
    expect(await getMounts('agent')).toEqual([])
  })

  it('corrupt file → getMounts degrades to [] (tolerant) and does NOT overwrite', async () => {
    // getMounts feeds read-only display + getMountsWithHealth (container start);
    // a corrupt file must NOT throw (which used to brick the whole agent) — it
    // degrades to [] while leaving the bytes intact for recovery.
    const { getMounts } = await importService()
    makeAgentDir('agent')
    const corrupt = '[ { "id": "a", '
    fs.writeFileSync(mountsPath('agent'), corrupt)
    expect(await getMounts('agent')).toEqual([])
    expect(fs.readFileSync(mountsPath('agent'), 'utf-8')).toBe(corrupt) // not clobbered
  })

  it('getMountsWithHealth on a corrupt file → [] (does NOT throw → container start survives)', async () => {
    const { getMountsWithHealth } = await importService()
    makeAgentDir('agent')
    fs.writeFileSync(mountsPath('agent'), '[ { "id": "a", ')
    await expect(getMountsWithHealth('agent')).resolves.toEqual([])
  })

  it('addMount on a corrupt file THROWS and does NOT overwrite (prior mounts preserved)', async () => {
    const { addMount } = await importService()
    makeAgentDir('agent')
    const corrupt = '[ { "id": "old-mount", "hostPath": "/x"'
    fs.writeFileSync(mountsPath('agent'), corrupt)

    await expect(addMount('agent', makeHostDir('newfolder'))).rejects.toThrow(CorruptFileError)
    // The unreadable file is left intact — NOT clobbered with just the new mount.
    expect(fs.readFileSync(mountsPath('agent'), 'utf-8')).toBe(corrupt)
  })
})

describe('atomic mounts.json writes', () => {
  it('addMount writes atomically (no temp file left behind) and round-trips', async () => {
    const { addMount, getMounts } = await importService()
    makeAgentDir('agent')
    await addMount('agent', makeHostDir('a'))
    await addMount('agent', makeHostDir('b'))

    const dir = path.dirname(mountsPath('agent'))
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(await getMounts('agent')).toHaveLength(2)
    // File is valid JSON.
    expect(() => JSON.parse(fs.readFileSync(mountsPath('agent'), 'utf-8'))).not.toThrow()
  })

  it('CONCURRENT addMount calls all survive (withFileLock prevents lost updates)', async () => {
    // The old sync implementation couldn't interleave by construction; the async
    // version relies on withFileLock to serialize the read-modify-write.
    const { addMount, getMounts } = await importService()
    makeAgentDir('agent')
    const names = ['m0', 'm1', 'm2', 'm3', 'm4']
    await Promise.all(names.map((n) => addMount('agent', makeHostDir(n))))
    expect((await getMounts('agent')).map((m) => m.folderName).sort()).toEqual([...names].sort())
  })
})
