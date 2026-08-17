import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { MtimeFileCache } from './mtime-file-cache'

describe('MtimeFileCache', () => {
  let dir: string
  let filePath: string
  let cache: MtimeFileCache<string>
  let loads: number

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mtime-file-cache-'))
    filePath = path.join(dir, 'note.txt')
    cache = new MtimeFileCache((value) => value)
    loads = 0
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  async function load(): Promise<string | undefined> {
    loads += 1
    try {
      return await fs.promises.readFile(filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  it('skips load when mtime and size are unchanged', async () => {
    await fs.promises.writeFile(filePath, 'hello')
    expect(await cache.get(filePath, load)).toBe('hello')
    expect(await cache.get(filePath, load)).toBe('hello')
    expect(loads).toBe(1)
  })

  it('reloads after the file is written', async () => {
    await fs.promises.writeFile(filePath, 'hello')
    await cache.get(filePath, load)
    await fs.promises.writeFile(filePath, 'world')
    expect(await cache.get(filePath, load)).toBe('world')
    expect(loads).toBe(2)
  })

  it('reloads when size changes even if mtime is copied back', async () => {
    await fs.promises.writeFile(filePath, 'aa')
    const { mtimeMs } = await fs.promises.stat(filePath)
    await cache.get(filePath, load)
    await fs.promises.writeFile(filePath, 'bbb')
    await fs.promises.utimes(filePath, new Date(mtimeMs), new Date(mtimeMs))
    expect(await cache.get(filePath, load)).toBe('bbb')
    expect(loads).toBe(2)
  })

  it('does not cache a miss, so a later create is visible', async () => {
    expect(await cache.get(filePath, load)).toBeUndefined()
    expect(loads).toBe(0)
    await fs.promises.writeFile(filePath, 'created')
    expect(await cache.get(filePath, load)).toBe('created')
    expect(loads).toBe(1)
  })

  it('overlapping gets share one load', async () => {
    await fs.promises.writeFile(filePath, 'shared')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const blockedLoad = async () => {
      await held
      return load()
    }

    const first = cache.get(filePath, blockedLoad)
    const second = cache.get(filePath, blockedLoad)
    release()
    expect(await first).toBe('shared')
    expect(await second).toBe('shared')
    expect(loads).toBe(1)
  })

  it('does not cache when mtimeMs is 0', async () => {
    await fs.promises.writeFile(filePath, 'epoch')
    await fs.promises.utimes(filePath, new Date(0), new Date(0))
    expect((await fs.promises.stat(filePath)).mtimeMs).toBe(0)
    expect(await cache.get(filePath, load)).toBe('epoch')
    expect(await cache.get(filePath, load)).toBe('epoch')
    expect(loads).toBe(2)
  })

  it('returns a clone so callers cannot mutate the stored value', async () => {
    const objectCache = new MtimeFileCache((value: { name: string }) => ({ ...value }))
    await fs.promises.writeFile(filePath, '{"name":"A"}')
    const first = await objectCache.get(filePath, async () =>
      JSON.parse(await fs.promises.readFile(filePath, 'utf-8')),
    )
    first!.name = 'mutated'
    const second = await objectCache.get(filePath, async () => {
      throw new Error('should not reload')
    })
    expect(second).toEqual({ name: 'A' })
  })
})
