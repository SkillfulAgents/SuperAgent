/**
 * Host-browser context maps (browserbase-provider / platform-provider).
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
import { loadContextMap, saveContextMap, setContextMapping, getOrCreateMapping } from './context-map-store'
import { CorruptFileError } from '@shared/lib/utils/file-storage'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

let tmpDir: string
let mapPath: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-map-')))
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

describe('getOrCreateMapping — dedups same-key creates (no duplicate context leak)', () => {
  it('concurrent first-opens for the SAME key create the context exactly once', async () => {
    let creates = 0
    const create = async () => {
      await delay(5) // hold the "remote create" open so all three race in the gap
      creates++
      return `ctx-${creates}`
    }
    const results = await Promise.all([
      getOrCreateMapping(mapPath, 'agentA', create),
      getOrCreateMapping(mapPath, 'agentA', create),
      getOrCreateMapping(mapPath, 'agentA', create),
    ])
    expect(creates).toBe(1) // the P2 leak: would be 3 without dedup
    expect(new Set(results).size).toBe(1) // every caller got the same id
    expect(loadContextMap(mapPath)).toEqual({ agentA: results[0] })
  })

  it('returns an already-persisted mapping without creating', async () => {
    saveContextMap(mapPath, { agentA: 'ctx-existing' })
    let creates = 0
    const id = await getOrCreateMapping(mapPath, 'agentA', async () => {
      creates++
      return 'ctx-new'
    })
    expect(id).toBe('ctx-existing')
    expect(creates).toBe(0)
  })

  it('different keys still create concurrently (not serialized by the dedup)', async () => {
    let creates = 0
    const create = (id: string) => async () => {
      await delay(5)
      creates++
      return id
    }
    const [a, b] = await Promise.all([
      getOrCreateMapping(mapPath, 'A', create('ctx-A')),
      getOrCreateMapping(mapPath, 'B', create('ctx-B')),
    ])
    expect([a, b]).toEqual(['ctx-A', 'ctx-B'])
    expect(creates).toBe(2)
    expect(loadContextMap(mapPath)).toEqual({ A: 'ctx-A', B: 'ctx-B' })
  })

  it('a failed create does not cache; the next call retries', async () => {
    let attempts = 0
    const flaky = async () => {
      attempts++
      if (attempts === 1) throw new Error('remote create failed')
      return 'ctx-ok'
    }
    await expect(getOrCreateMapping(mapPath, 'agentA', flaky)).rejects.toThrow('remote create failed')
    expect(await getOrCreateMapping(mapPath, 'agentA', flaky)).toBe('ctx-ok')
    expect(attempts).toBe(2)
  })
})
