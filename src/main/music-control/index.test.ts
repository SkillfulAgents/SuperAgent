import { describe, it, expect, vi, beforeEach } from 'vitest'

const electron = vi.hoisted(() => ({ isPackaged: false, appPath: '/app' }))
vi.mock('electron', () => ({
  app: { get isPackaged() { return electron.isPackaged }, getAppPath: () => electron.appPath },
}))
const backend = vi.hoisted(() => ({
  probe: vi.fn<() => Promise<{ id: string; name: string } | null>>(),
  pause: vi.fn<(id: string) => Promise<void>>(),
  play: vi.fn<(id: string) => Promise<void>>(),
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
    backend.play.mockResolvedValue()
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
    await expect(service.pauseNowPlaying()).resolves.toEqual({ paused: null })
    await service.resumeNowPlaying('p1')
    expect(backend.play).not.toHaveBeenCalled()
  })

  it('pauses only what is playing and says which player that was', async () => {
    const service = await import('./index')
    await expect(service.pauseNowPlaying()).resolves.toEqual({ paused: { id: 'p1', name: 'Spotify' } })
    expect(backend.pause).toHaveBeenCalledWith('p1')
    backend.probe.mockResolvedValue(null)
    await expect(service.pauseNowPlaying()).resolves.toEqual({ paused: null })
    expect(backend.pause).toHaveBeenCalledTimes(1)
  })

  it('treats a failing backend as nothing playing rather than an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    backend.probe.mockRejectedValue(new Error('timed out'))
    backend.play.mockRejectedValue(new Error('gone'))
    const service = await import('./index')
    await expect(service.probeNowPlaying()).resolves.toEqual({ supported: true, player: null })
    await expect(service.pauseNowPlaying()).resolves.toEqual({ paused: null })
    await expect(service.resumeNowPlaying('p1')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })
})
