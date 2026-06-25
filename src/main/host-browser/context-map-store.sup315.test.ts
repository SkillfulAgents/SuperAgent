/**
 * SUP-315 — host-browser context maps (browserbase-provider / platform-provider).
 * The instanceId → contextId map is read-modify-written from concurrent
 * getOrCreateContext calls that await a network create between read and write.
 * The old read swallowed errors to `{}` and the write was non-atomic, so a bad
 * read or a race wiped every other agent's persistent context — leaking paid
 * Browserbase contexts. These tests cover the shared hardened store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { loadContextMap, saveContextMap, setContextMapping } from './context-map-store'
import { CorruptFileError } from '@shared/lib/utils/file-storage'

let tmpDir: string
let mapPath: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-map-sup315-')))
  mapPath = path.join(tmpDir, 'contexts.json')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadContextMap — fail-closed', () => {
  it('absent file → {}', () => {
    expect(loadContextMap(mapPath)).toEqual({})
  })

  it('valid file → parsed map', () => {
    fs.writeFileSync(mapPath, JSON.stringify({ inst1: 'ctx-1', inst2: 'ctx-2' }))
    expect(loadContextMap(mapPath)).toEqual({ inst1: 'ctx-1', inst2: 'ctx-2' })
  })

  it('corrupt/torn file → THROWS (does not silently return {})', () => {
    fs.writeFileSync(mapPath, '{ "inst1": "ctx')
    expect(() => loadContextMap(mapPath)).toThrow(CorruptFileError)
  })
})

describe('saveContextMap — atomic', () => {
  it('round-trips and leaves no temp file behind', () => {
    saveContextMap(mapPath, { a: '1' })
    expect(loadContextMap(mapPath)).toEqual({ a: '1' })
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('creates the parent directory if missing', () => {
    const nested = path.join(tmpDir, 'sub', 'dir', 'contexts.json')
    saveContextMap(nested, { x: 'y' })
    expect(loadContextMap(nested)).toEqual({ x: 'y' })
  })
})

describe('setContextMapping — serialized + atomic upsert (the headline fix)', () => {
  it('concurrent upserts for DIFFERENT keys ALL survive (no clobbering)', async () => {
    const keys = Array.from({ length: 25 }, (_, i) => `instance-${i}`)
    // Fire all upserts at once — without the lock + fresh re-read these would
    // clobber each other down to a single entry.
    await Promise.all(keys.map((k) => setContextMapping(mapPath, k, `ctx-${k}`)))

    const map = loadContextMap(mapPath)
    expect(Object.keys(map).sort()).toEqual([...keys].sort())
    for (const k of keys) expect(map[k]).toBe(`ctx-${k}`)
  })

  it('preserves an existing mapping when adding a new one', async () => {
    saveContextMap(mapPath, { existing: 'ctx-existing' })
    await setContextMapping(mapPath, 'fresh', 'ctx-fresh')
    expect(loadContextMap(mapPath)).toEqual({ existing: 'ctx-existing', fresh: 'ctx-fresh' })
  })

  it('throws on a corrupt map rather than overwriting it (fail-closed)', async () => {
    const corrupt = '{ "existing": "ctx'
    fs.writeFileSync(mapPath, corrupt)
    await expect(setContextMapping(mapPath, 'fresh', 'ctx-fresh')).rejects.toThrow(CorruptFileError)
    expect(fs.readFileSync(mapPath, 'utf-8')).toBe(corrupt)
  })
})
