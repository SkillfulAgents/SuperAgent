import { describe, it, expect, vi, beforeEach } from 'vitest'

const electron = vi.hoisted(() => ({ isPackaged: false, appPath: '/app' }))
vi.mock('electron', () => ({
  app: { get isPackaged() { return electron.isPackaged }, getAppPath: () => electron.appPath },
}))
const backend = vi.hoisted(() => ({
  probe: vi.fn<() => Promise<{ id: string; name: string } | null>>(),
  pause: vi.fn<(id: string) => Promise<void>>(),
  play: vi.fn<(id: string) => Promise<boolean>>(),
}))
const select = vi.hoisted(() => ({ selectNowPlayingBackend: vi.fn<(platform: string, dir: string) => typeof backend | null>() }))
vi.mock('./select-backend', () => select)

describe('music control service', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    select.selectNowPlayingBackend.mockReturnValue(backend)
    backend.probe.mockResolvedValue({ id: 'p1', name: 'Spotify' })
    backend.pause.mockResolvedValue()
    backend.play.mockResolvedValue(true)
  })

  it('looks for the adapter next to the checkout in dev and under resources when packaged', async () => {
    let service = await import('./index')
    await service.probeNowPlaying()
    expect(select.selectNowPlayingBackend).toHaveBeenCalledWith(process.platform, '/app/build/mediaremote-adapter')
    vi.resetModules()
    electron.isPackaged = true
    const resources = (process as { resourcesPath?: string }).resourcesPath
    ;(process as { resourcesPath?: string }).resourcesPath = '/Applications/App.app/Contents/Resources'
    try {
      service = await import('./index')
      await service.probeNowPlaying()
      expect(select.selectNowPlayingBackend).toHaveBeenLastCalledWith(process.platform, '/Applications/App.app/Contents/Resources/mediaremote-adapter')
    } finally {
      ;(process as { resourcesPath?: string }).resourcesPath = resources
      electron.isPackaged = false
    }
  })

  it('reports an unsupported host without asking anything', async () => {
    select.selectNowPlayingBackend.mockReturnValue(null)
    const service = await import('./index')
    await expect(service.probeNowPlaying()).resolves.toEqual({ supported: false, player: null })
    await expect(service.pauseNowPlaying(1)).resolves.toEqual({ paused: null })
    await expect(service.resumeNowPlaying(1, 'p1')).resolves.toEqual({ outcome: 'released' })
    expect(backend.play).not.toHaveBeenCalled()
  })

  it('pauses only what is playing and says which player that was', async () => {
    const service = await import('./index')
    await expect(service.pauseNowPlaying(1)).resolves.toEqual({ paused: { id: 'p1', name: 'Spotify' } })
    expect(backend.pause).toHaveBeenCalledWith('p1')
    backend.probe.mockResolvedValue(null)
    await expect(service.pauseNowPlaying(1)).resolves.toEqual({ paused: null })
    expect(backend.pause).toHaveBeenCalledTimes(1)
  })

  it('treats a failing backend as nothing playing rather than an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    backend.probe.mockRejectedValue(new Error('timed out'))
    backend.play.mockRejectedValue(new Error('gone'))
    const service = await import('./index')
    await expect(service.probeNowPlaying()).resolves.toEqual({ supported: true, player: null })
    await expect(service.pauseNowPlaying(1)).resolves.toEqual({ paused: null })
    await expect(service.resumeNowPlaying(1, 'p1')).resolves.toEqual({ outcome: 'failed' })
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it('says whether the held player played again', async () => {
    const service = await import('./index')
    await expect(service.resumeNowPlaying(1, 'p1')).resolves.toEqual({ outcome: 'resumed' })
    backend.play.mockResolvedValue(false)
    await expect(service.resumeNowPlaying(1, 'p1')).resolves.toEqual({ outcome: 'released' })
  })

  it('gives back what a window holds when it goes away, and only that', async () => {
    const service = await import('./index')
    await service.pauseNowPlaying(1)
    await service.pauseNowPlaying(2)
    await service.resumeNowPlaying(2, 'p1')
    backend.play.mockClear()
    await service.releaseNowPlaying(2)
    expect(backend.play).not.toHaveBeenCalled()
    await service.releaseNowPlaying(1)
    expect(backend.play).toHaveBeenCalledWith('p1')
    await service.releaseNowPlaying(1)
    expect(backend.play).toHaveBeenCalledTimes(1)
  })

  it('keeps the hold after a failed resume so closing the window still gives the music back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = await import('./index')
    await service.pauseNowPlaying(1)
    backend.play.mockRejectedValueOnce(new Error('timed out'))
    await expect(service.resumeNowPlaying(1, 'p1')).resolves.toEqual({ outcome: 'failed' })
    await service.releaseAllNowPlaying()
    expect(backend.play).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('releases a watched window when it is destroyed or loads a new document', async () => {
    const service = await import('./index')
    const listeners = new Map<string, (details?: { isMainFrame: boolean; isSameDocument: boolean }) => void>()
    const contents = {
      id: 7,
      once: vi.fn((event: string, listener: () => void) => { listeners.set(event, listener) }),
      on: vi.fn((event: string, listener: (details?: { isMainFrame: boolean; isSameDocument: boolean }) => void) => { listeners.set(event, listener) }),
    }
    service.watchNowPlayingHolder(contents)
    service.watchNowPlayingHolder(contents)
    expect(contents.once).toHaveBeenCalledTimes(1)
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

    await service.pauseNowPlaying(7)
    listeners.get('did-start-navigation')!({ isMainFrame: true, isSameDocument: true })
    listeners.get('did-start-navigation')!({ isMainFrame: false, isSameDocument: false })
    await settle()
    expect(backend.play).not.toHaveBeenCalled()
    listeners.get('did-start-navigation')!({ isMainFrame: true, isSameDocument: false })
    await settle()
    expect(backend.play).toHaveBeenCalledTimes(1)

    await service.pauseNowPlaying(7)
    listeners.get('destroyed')!()
    await settle()
    expect(backend.play).toHaveBeenCalledTimes(2)
  })

  it('pauses a player it told to play a moment ago even while the OS still reports it paused', async () => {
    vi.useFakeTimers()
    try {
      const service = await import('./index')
      await service.pauseNowPlaying(1)
      await service.resumeNowPlaying(1, 'p1')
      backend.probe.mockResolvedValue(null) // The OS has not caught up with the play yet.
      await expect(service.pauseNowPlaying(1)).resolves.toEqual({ paused: { id: 'p1', name: 'Spotify' } })
      expect(backend.pause).toHaveBeenCalledTimes(2)

      await service.resumeNowPlaying(1, 'p1')
      vi.advanceTimersByTime(service.PLAY_SETTLE_MS)
      await expect(service.pauseNowPlaying(1)).resolves.toEqual({ paused: null })
      expect(backend.pause).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
