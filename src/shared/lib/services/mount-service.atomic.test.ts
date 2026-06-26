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
    expect(getMounts('agent')).toEqual([])
  })

  it('corrupt file → getMounts degrades to [] (tolerant) and does NOT overwrite', async () => {
    // getMounts feeds read-only display + getMountsWithHealth (container start);
    // a corrupt file must NOT throw (which used to brick the whole agent) — it
    // degrades to [] while leaving the bytes intact for recovery.
    const { getMounts } = await importService()
    makeAgentDir('agent')
    const corrupt = '[ { "id": "a", '
    fs.writeFileSync(mountsPath('agent'), corrupt)
    expect(getMounts('agent')).toEqual([])
    expect(fs.readFileSync(mountsPath('agent'), 'utf-8')).toBe(corrupt) // not clobbered
  })

  it('getMountsWithHealth on a corrupt file → [] (does NOT throw → container start survives)', async () => {
    const { getMountsWithHealth } = await importService()
    makeAgentDir('agent')
    fs.writeFileSync(mountsPath('agent'), '[ { "id": "a", ')
    expect(() => getMountsWithHealth('agent')).not.toThrow()
    expect(getMountsWithHealth('agent')).toEqual([])
  })

  it('addMount on a corrupt file THROWS and does NOT overwrite (prior mounts preserved)', async () => {
    const { addMount } = await importService()
    makeAgentDir('agent')
    const corrupt = '[ { "id": "old-mount", "hostPath": "/x"'
    fs.writeFileSync(mountsPath('agent'), corrupt)

    expect(() => addMount('agent', makeHostDir('newfolder'))).toThrow(CorruptFileError)
    // The unreadable file is left intact — NOT clobbered with just the new mount.
    expect(fs.readFileSync(mountsPath('agent'), 'utf-8')).toBe(corrupt)
  })
})

describe('atomic mounts.json writes', () => {
  it('addMount writes atomically (no temp file left behind) and round-trips', async () => {
    const { addMount, getMounts } = await importService()
    makeAgentDir('agent')
    addMount('agent', makeHostDir('a'))
    addMount('agent', makeHostDir('b'))

    const dir = path.dirname(mountsPath('agent'))
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(getMounts('agent')).toHaveLength(2)
    // File is valid JSON.
    expect(() => JSON.parse(fs.readFileSync(mountsPath('agent'), 'utf-8'))).not.toThrow()
  })

  it('a batch of addMount calls all survive (no lost update)', async () => {
    const { addMount, getMounts } = await importService()
    makeAgentDir('agent')
    const names = ['m0', 'm1', 'm2', 'm3', 'm4']
    for (const n of names) addMount('agent', makeHostDir(n))
    expect(getMounts('agent').map((m) => m.folderName).sort()).toEqual([...names].sort())
  })
})
