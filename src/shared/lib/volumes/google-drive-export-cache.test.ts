import { describe, expect, it, vi } from 'vitest'
import { driveFileSchema } from './google-drive-schema'
import { GoogleDriveExportCache } from './google-drive-export-cache'

const doc = (id: string, modifiedTime = '2026-10-07T12:00:00Z') => driveFileSchema.parse({ id, name: id, mimeType: 'application/vnd.google-apps.document', modifiedTime })
const item = (id: string, modifiedTime?: string) => ({ file: doc(id, modifiedTime) })

describe('Google Drive export cache', () => {
  it('keys sizes by account and version, and remembers an export that was too large', async () => {
    const cache = new GoogleDriveExportCache()
    const exporter = vi.fn(async ({ file }: { file: { id: string } }) => file.id === 'big' ? 'too-large' as const : new Uint8Array(42))
    await cache.learn('a', [item('x'), item('big')], exporter)
    await cache.learn('a', [item('x'), item('big')], exporter)
    expect(exporter).toHaveBeenCalledTimes(2)
    expect(cache.size('a', doc('x'))).toBe(42)
    expect(cache.tooLarge('a', doc('big'))).toBe(true)
    expect(cache.size('a', doc('x', '2026-10-07T12:00:01Z'))).toBeUndefined()
    expect(cache.size('b', doc('x'))).toBeUndefined()
    await cache.learn('a', [item('x', '2026-10-07T12:00:01Z')], exporter)
    await cache.learn('b', [item('x')], exporter)
    expect(exporter).toHaveBeenCalledTimes(4)
  })

  it('runs at most sixteen exports at a time and fails only after the rest settle, keeping what they learned', async () => {
    const cache = new GoogleDriveExportCache()
    let running = 0
    let peak = 0
    let failing = true
    const exporter = vi.fn(async ({ file }: { file: { id: string } }) => {
      running++
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 1))
      running--
      if (file.id === 'd3' && failing) { failing = false; throw new Error('rate limited') }
      return new Uint8Array(7)
    })
    const files = Array.from({ length: 40 }, (_, i) => item(`d${i}`))
    await expect(cache.learn('a', files, exporter)).rejects.toThrow('rate limited')
    expect(peak).toBe(16)
    expect(exporter).toHaveBeenCalledTimes(40)
    expect(cache.size('a', doc('d39'))).toBe(7)
    expect(cache.size('a', doc('d3'))).toBeUndefined()
    await cache.learn('a', files, exporter)
    expect(exporter).toHaveBeenCalledTimes(41)
  })

  it('retains every listing size after byte eviction, without re-exporting to list again', async () => {
    const cache = new GoogleDriveExportCache()
    const files = Array.from({ length: 21 }, (_, i) => item(`d${i}`))
    const exporter = vi.fn(async () => new Uint8Array(5 * 1024 * 1024))
    const learned = await cache.learn('a', files, exporter)
    expect([...learned.values()]).toEqual(Array(21).fill(5 * 1024 * 1024))
    expect(files.map(entry => cache.size('a', entry.file))).toEqual([...learned.values()])
    await cache.learn('a', files, exporter)
    expect(exporter).toHaveBeenCalledTimes(21)
    // File bytes really were evicted; a later download loads them again.
    await cache.exported('a', files[0].file, exporter)
    expect(exporter).toHaveBeenCalledTimes(22)
  })

  it('returns a complete listing snapshot even beyond the metadata entry limit', async () => {
    const cache = new GoogleDriveExportCache()
    const files = Array.from({ length: 8001 }, (_, i) => item(`d${i}`))
    const sizes = await cache.learn('a', files, async () => new Uint8Array(1))
    expect(sizes.size).toBe(8001)
    expect(sizes.get(files[0].file)).toBe(1)
    expect(cache.size('a', files[0].file)).toBeUndefined()
  })

  it('coalesces concurrent exports and shares the concurrency cap across listings', async () => {
    const cache = new GoogleDriveExportCache()
    let active = 0, peak = 0
    const exporter = vi.fn(async () => {
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--
      return new Uint8Array(2)
    })
    const files = Array.from({ length: 40 }, (_, i) => item(`d${i}`))
    const [first, second] = await Promise.all([cache.learn('a', files, exporter), cache.learn('a', files, exporter)])
    expect(first.size).toBe(40)
    expect(second.size).toBe(40)
    expect(exporter).toHaveBeenCalledTimes(40)
    expect(peak).toBe(16)
  })

})
