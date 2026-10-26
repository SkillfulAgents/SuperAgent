import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeLocalFolders, openLocalFolder, setFolderAccessStarter } from './local-folder-access'

let folder: string
beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-access-'))
})
afterEach(() => {
  closeLocalFolders()
  setFolderAccessStarter(null)
  fs.chmodSync(folder, 0o700)
  fs.rmSync(folder, { recursive: true, force: true })
})

describe('outside the sandbox', () => {
  it('counts every folder as open, with or without a bookmark', () => {
    expect(openLocalFolder(undefined, folder)).toBe(true)
    expect(openLocalFolder('Ym9va21hcms=', folder)).toBe(true)
  })
})

describe('in the sandbox', () => {
  it('opens a folder once through its bookmark, and closes it at quit', () => {
    const stop = vi.fn()
    const start = vi.fn(() => stop)
    setFolderAccessStarter(start)

    expect(openLocalFolder('bm', folder)).toBe(true)
    expect(openLocalFolder('bm', folder)).toBe(true)
    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith('bm')

    closeLocalFolders()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('reopens the folder on the next launch from the same bookmark', () => {
    setFolderAccessStarter(() => () => {})
    expect(openLocalFolder('bm', folder)).toBe(true)
    closeLocalFolders()

    const relaunch = vi.fn(() => () => {})
    setFolderAccessStarter(relaunch)
    expect(openLocalFolder('bm', folder)).toBe(true)
    expect(relaunch).toHaveBeenCalledWith('bm')
  })

  it('has a folder without a bookmark picked again', () => {
    const start = vi.fn(() => () => {})
    setFolderAccessStarter(start)
    expect(openLocalFolder(undefined, folder)).toBe(false)
    expect(start).not.toHaveBeenCalled()
  })

  it('has a folder whose bookmark no longer resolves picked again, without retrying it on every read', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const start = vi.fn(() => {
      throw new Error('bookmarkDataIsStale - try recreating the bookmark')
    })
    setFolderAccessStarter(start)

    expect(openLocalFolder('stale', folder)).toBe(false)
    expect(openLocalFolder('stale', folder)).toBe(false)
    expect(start).toHaveBeenCalledOnce()
  })

  // Electron returns a stop function for any bookmark, even one that opens
  // nothing (seen on a sandboxed build), so only reading the folder tells.
  it.skipIf(process.getuid?.() === 0)('has a folder picked again when its bookmark starts but the folder still can’t be read, and stops that access', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fs.chmodSync(folder, 0o000)
    const stop = vi.fn()
    setFolderAccessStarter(() => stop)

    expect(openLocalFolder('opens-nothing', folder)).toBe(false)
    expect(stop).toHaveBeenCalledOnce()
    expect(openLocalFolder('opens-nothing', folder)).toBe(false)
  })

  it('leaves a folder that is gone to the drive’s own check, which reports it missing', () => {
    setFolderAccessStarter(() => () => {})
    expect(openLocalFolder('bm', path.join(folder, 'gone'))).toBe(true)
  })
})
