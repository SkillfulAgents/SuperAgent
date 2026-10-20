// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { zipSync } from 'fflate'
import { archiveFolders, useZipFile } from './archive-renderer'
import { MAX_ZIP_ENTRIES } from './zip-archive'

describe('archiveFolders', () => {
  it('puts every file under its folder, adding folders the zip does not list', () => {
    const folders = archiveFolders(['report/data/q3.csv', 'report/summary.md', 'readme.txt'])
    expect(folders?.get('')).toEqual([
      { name: 'report', path: 'report', type: 'directory' },
      { name: 'readme.txt', path: 'readme.txt', type: 'file' },
    ])
    expect(folders?.get('report')).toEqual([
      { name: 'data', path: 'report/data', type: 'directory' },
      { name: 'summary.md', path: 'report/summary.md', type: 'file' },
    ])
    expect(folders?.get('report/data')).toEqual([{ name: 'q3.csv', path: 'report/data/q3.csv', type: 'file' }])
  })

  it('keeps listed empty folders and hides what macOS adds', () => {
    const folders = archiveFolders(['empty/', 'a.md', '.DS_Store', 'empty/.DS_Store', '__MACOSX/._a.md'])
    expect(folders?.get('')).toEqual([
      { name: 'empty', path: 'empty', type: 'directory' },
      { name: 'a.md', path: 'a.md', type: 'file' },
    ])
    expect(folders?.get('empty')).toEqual([])
  })

  it('keeps a file\'s zip name as its path, skips empty segments, and lets a folder win over a file of the same name', () => {
    const folders = archiveFolders(['/top.md', 'a//b.md', 'x', 'x/y.md', 'z/', 'z', ''])
    expect(folders?.get('')).toEqual([
      { name: 'a', path: 'a', type: 'directory' },
      { name: 'x', path: 'x', type: 'directory' },
      { name: 'z', path: 'z', type: 'directory' },
      { name: 'top.md', path: '/top.md', type: 'file' },
    ])
    expect(folders?.get('a')).toEqual([{ name: 'b.md', path: 'a//b.md', type: 'file' }])
  })

  it('counts the folders it adds against the listing limit', () => {
    expect(archiveFolders(Array.from({ length: MAX_ZIP_ENTRIES / 2 + 1 }, (_, i) => `d${i}/f`))).toBeNull()
  })
})

describe('useZipFile', () => {
  it('revokes each file URL when another opens or the view goes, and never renders a URL under another file', () => {
    let made = 0
    const revoked: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++made}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => { revoked.push(url) })
    // Not strToU8: under jsdom it encodes through jsdom's TextEncoder, whose arrays fflate does not recognize.
    const bytes = zipSync({ 'a.md': Uint8Array.of(65), 'b.md': Uint8Array.of(66) })
    const rendered: [string | null, string | undefined][] = []
    const { rerender, unmount } = renderHook(({ path }) => {
      const file = useZipFile(bytes, path)
      rendered.push([path, file && 'inlineUrl' in file ? file.inlineUrl : undefined])
      return file
    }, { initialProps: { path: 'a.md' as string | null } })

    rerender({ path: 'b.md' })
    rerender({ path: null })
    expect(revoked).toEqual(['blob:1', 'blob:2'])
    rerender({ path: 'a.md' })
    unmount()
    expect(revoked).toEqual(['blob:1', 'blob:2', 'blob:3'])
    // Each URL only ever renders beside the file it was made for.
    const owner = { 'blob:1': 'a.md', 'blob:2': 'b.md', 'blob:3': 'a.md' } as Record<string, string>
    expect(rendered.filter(([, url]) => url).every(([path, url]) => url && owner[url] === path)).toBe(true)
  })

  it('gives the reason when a file cannot be unpacked', () => {
    const bytes = zipSync({ 'a.md': Uint8Array.of(65) })
    bytes[8] = 99 // the local header's compression method: one fflate cannot inflate
    const { result } = renderHook(() => useZipFile(bytes, 'a.md'))
    expect(result.current).toEqual({ reason: "Can't read this file. Download the zip to open it." })
  })
})
