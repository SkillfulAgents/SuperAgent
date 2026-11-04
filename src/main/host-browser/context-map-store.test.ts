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
import { loadContextMap, getOrCreateMapping } from './context-map-store'
import { CorruptFileError } from '@shared/lib/utils/file-storage'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const FILE = 'contexts.json'
let tmpDir: string
let mapPath: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-map-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
  mapPath = path.join(tmpDir, FILE)
})

afterEach(() => {
  delete process.env.SUPERAGENT_DATA_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const writeMap = (map: Record<string, string>) => fs.writeFileSync(mapPath, JSON.stringify(map))

describe('loadContextMap — fail-closed', () => {
  it('absent file → {}', () => {
    expect(loadContextMap(FILE)).toEqual({})
  })

  it('valid file → parsed map', () => {
    fs.writeFileSync(mapPath, JSON.stringify({ inst1: 'ctx-1', inst2: 'ctx-2' }))
    expect(loadContextMap(FILE)).toEqual({ inst1: 'ctx-1', inst2: 'ctx-2' })
  })

  it('corrupt/torn file → THROWS (does not silently return {})', () => {
    fs.writeFileSync(mapPath, '{ "inst1": "ctx')
    expect(() => loadContextMap(FILE)).toThrow(CorruptFileError)
  })
})

describe('saving a mapping — atomic', () => {
  it('round-trips and leaves no temp file behind', async () => {
    await getOrCreateMapping(FILE, 'a', async () => '1')
    expect(loadContextMap(FILE)).toEqual({ a: '1' })
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('creates the data directory if missing', async () => {
    process.env.SUPERAGENT_DATA_DIR = path.join(tmpDir, 'sub', 'dir')
    await getOrCreateMapping(FILE, 'x', async () => 'y')
    expect(loadContextMap(FILE)).toEqual({ x: 'y' })
  })
})

describe('saving a mapping — fresh read-modify-write (the headline fix)', () => {
  it('concurrent creates for DIFFERENT keys ALL survive (no clobbering)', async () => {
    const keys = Array.from({ length: 25 }, (_, i) => `instance-${i}`)
    // Fire all creates at once — without a fresh re-read on save these would
    // clobber each other down to a single entry.
    await Promise.all(keys.map((k) => getOrCreateMapping(FILE, k, async () => `ctx-${k}`)))

    const map = loadContextMap(FILE)
    expect(Object.keys(map).sort()).toEqual([...keys].sort())
    for (const k of keys) expect(map[k]).toBe(`ctx-${k}`)
  })

  it('preserves an existing mapping when adding a new one', async () => {
    writeMap({ existing: 'ctx-existing' })
    await getOrCreateMapping(FILE, 'fresh', async () => 'ctx-fresh')
    expect(loadContextMap(FILE)).toEqual({ existing: 'ctx-existing', fresh: 'ctx-fresh' })
  })

  it('throws on a corrupt map rather than overwriting it (fail-closed)', async () => {
    const corrupt = '{ "existing": "ctx'
    fs.writeFileSync(mapPath, corrupt)
    await expect(getOrCreateMapping(FILE, 'fresh', async () => 'ctx-fresh')).rejects.toThrow(CorruptFileError)
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
      getOrCreateMapping(FILE, 'agentA', create),
      getOrCreateMapping(FILE, 'agentA', create),
      getOrCreateMapping(FILE, 'agentA', create),
    ])
    expect(creates).toBe(1) // the P2 leak: would be 3 without dedup
    expect(new Set(results).size).toBe(1) // every caller got the same id
    expect(loadContextMap(FILE)).toEqual({ agentA: results[0] })
  })

  it('returns an already-persisted mapping without creating', async () => {
    writeMap({ agentA: 'ctx-existing' })
    let creates = 0
    const id = await getOrCreateMapping(FILE, 'agentA', async () => {
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
      getOrCreateMapping(FILE, 'A', create('ctx-A')),
      getOrCreateMapping(FILE, 'B', create('ctx-B')),
    ])
    expect([a, b]).toEqual(['ctx-A', 'ctx-B'])
    expect(creates).toBe(2)
    expect(loadContextMap(FILE)).toEqual({ A: 'ctx-A', B: 'ctx-B' })
  })

  it('a failed create does not cache; the next call retries', async () => {
    let attempts = 0
    const flaky = async () => {
      attempts++
      if (attempts === 1) throw new Error('remote create failed')
      return 'ctx-ok'
    }
    await expect(getOrCreateMapping(FILE, 'agentA', flaky)).rejects.toThrow('remote create failed')
    expect(await getOrCreateMapping(FILE, 'agentA', flaky)).toBe('ctx-ok')
    expect(attempts).toBe(2)
  })

  it('rethrows (does not swallow) when persisting a freshly-created paid context fails', async () => {
    // create() succeeds (a paid remote context now exists), but the map file is
    // corrupt by persist time, so the save's strict re-read throws. The
    // error must propagate (so the orphaned id is captured/surfaced, not silently
    // dropped) rather than be swallowed.
    let creates = 0
    const create = async () => {
      creates++
      fs.writeFileSync(mapPath, '{ corrupt') // map becomes unreadable between create and persist
      return 'ctx-paid'
    }
    await expect(getOrCreateMapping(FILE, 'agentA', create)).rejects.toThrow(CorruptFileError)
    expect(creates).toBe(1) // the paid context was created — confirms the leak surface this guards
  })
})
