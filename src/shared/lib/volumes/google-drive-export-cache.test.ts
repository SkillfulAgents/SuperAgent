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
})
