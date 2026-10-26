import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeLocalFolders, openLocalFolder, setFolderAccessStarter } from './local-folder-access'

afterEach(() => {
  closeLocalFolders()
  setFolderAccessStarter(null)
})

describe('outside the sandbox', () => {
  it('counts every folder as open, with or without a bookmark', () => {
    expect(openLocalFolder(undefined)).toBe(true)
    expect(openLocalFolder('Ym9va21hcms=')).toBe(true)
  })
})

describe('in the sandbox', () => {
  it('opens a folder once through its bookmark, and closes it at quit', () => {
    const stop = vi.fn()
    const start = vi.fn(() => stop)
    setFolderAccessStarter(start)

    expect(openLocalFolder('bm')).toBe(true)
    expect(openLocalFolder('bm')).toBe(true)
    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith('bm')

    closeLocalFolders()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('reopens the folder on the next launch from the same bookmark', () => {
    setFolderAccessStarter(() => () => {})
    expect(openLocalFolder('bm')).toBe(true)
    closeLocalFolders()

    const relaunch = vi.fn(() => () => {})
    setFolderAccessStarter(relaunch)
    expect(openLocalFolder('bm')).toBe(true)
    expect(relaunch).toHaveBeenCalledWith('bm')
  })

  it('has a folder without a bookmark picked again', () => {
    const start = vi.fn(() => () => {})
    setFolderAccessStarter(start)
    expect(openLocalFolder(undefined)).toBe(false)
    expect(start).not.toHaveBeenCalled()
  })

  it('has a folder whose bookmark went stale picked again, without retrying it on every read', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const start = vi.fn(() => {
      throw new Error('bookmarkDataIsStale - try recreating the bookmark')
    })
    setFolderAccessStarter(start)

    expect(openLocalFolder('stale')).toBe(false)
    expect(openLocalFolder('stale')).toBe(false)
    expect(start).toHaveBeenCalledOnce()
  })
})
