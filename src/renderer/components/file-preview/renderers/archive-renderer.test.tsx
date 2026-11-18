// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { zipSync } from 'fflate'
import { archiveFolders, useZipFiles } from './archive-renderer'
import { NO_PREVIEW } from './unsupported-renderer'
import { MAX_ZIP_ENTRIES } from './zip-archive'

afterEach(() => vi.restoreAllMocks())

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

  it('lets a folder win over a file of the same name, whichever comes first', () => {
    const folders = archiveFolders(['x', 'x/y.md', 'z/', 'z'])
    expect(folders?.get('')).toEqual([
      { name: 'x', path: 'x', type: 'directory' },
      { name: 'z', path: 'z', type: 'directory' },
    ])
  })

  it('counts the folders it adds against the listing limit', () => {
    expect(archiveFolders(Array.from({ length: MAX_ZIP_ENTRIES / 2 + 1 }, (_, i) => `d${i}/f`))).toBeNull()
  })
})

describe('useZipFiles', () => {
  // Not strToU8: under jsdom it encodes through jsdom's TextEncoder, whose arrays fflate does not recognize.
  const bytes = zipSync({ 'a.png': Uint8Array.of(1), 'b.svg': Uint8Array.of(60), 'c.html': Uint8Array.of(60), 'd.md': Uint8Array.of(60), 'e.xml': Uint8Array.of(60) })

  it('opens each entry once at one URL, gives types that can run script a data: URL, and revokes every URL when the view goes', () => {
    let made = 0
    const revoked: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++made}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => { revoked.push(url) })
    const { result, unmount } = renderHook(() => useZipFiles(bytes), { reactStrictMode: true })
    const open = result.current!

    expect(open('a.png')).toEqual({ inlineUrl: 'blob:1' })
    expect(open('a.png')).toEqual({ inlineUrl: 'blob:1' })
    expect(open('b.svg')).toEqual({ inlineUrl: 'data:image/svg+xml;base64,PA==' })
    expect(open('c.html')).toEqual({ inlineUrl: 'data:text/html;base64,PA==' })
    expect(open('e.xml')).toEqual({ inlineUrl: 'data:text/xml;base64,PA==' })
    expect(open('d.md')).toEqual({ inlineUrl: 'blob:2' })
    unmount()
    expect(revoked).toEqual(expect.arrayContaining(['blob:1', 'blob:2']))
  })

  it('gives the reason, and does not unpack a file no renderer shows', () => {
    const broken = zipSync({ 'a.md': Uint8Array.of(65), 'sheet.xlsx': Uint8Array.of(1) })
    // Every central directory record's compression method: one the reader cannot inflate.
    broken.forEach((_, i) => {
      if (broken[i] === 0x50 && broken[i + 1] === 0x4b && broken[i + 2] === 1 && broken[i + 3] === 2) broken[i + 10] = 99
    })
    const { result } = renderHook(() => useZipFiles(broken))
    expect(result.current!('sheet.xlsx')).toEqual({ reason: NO_PREVIEW })
    expect(result.current!('a.md')).toEqual({ reason: "Can't read this file. Download the zip to open it." })
  })

  it('refuses a data: URL longer than a frame can load', () => {
    const big = zipSync({ 'big.html': new Uint8Array(1_600_000) })
    const { result } = renderHook(() => useZipFiles(big))
    expect(result.current!('big.html')).toEqual({ reason: 'Too much content to preview. Download the zip to open it.' })
  })
})
