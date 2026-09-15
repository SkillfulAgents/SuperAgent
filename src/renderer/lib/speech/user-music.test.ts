import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UserMusic, type MusicBridge } from './user-music'

const spotify = { id: 'com.spotify.client', name: 'Spotify' }

/** A host whose player state the test can move under voice mode's feet. */
function host(initial: { id: string; name: string } | null) {
  const state = { playing: initial }
  const bridge: MusicBridge = {
    probe: vi.fn(async () => ({ supported: true, player: state.playing })),
    pause: vi.fn(async () => {
      const paused = state.playing
      state.playing = null
      return { paused }
    }),
    resume: vi.fn(async (playerId: string) => {
      state.playing = { id: playerId, name: 'resumed' }
    }),
  }
  return { bridge, state }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('UserMusic', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is unavailable without the bridge and then does nothing', async () => {
    const music = new UserMusic({ bridge: null })
    expect(music.available).toBe(false)
    await music.begin()
    music.start()
    music.stop()
    await music.end()
    expect(music.getState()).toEqual({ active: false, playerName: null })
  })

  it('takes over a playing player when voice mode begins and gives it back at the end', async () => {
    const { bridge, state } = host(spotify)
    const music = new UserMusic({ bridge })
    const changes = vi.fn()
    music.subscribe(changes)
    await music.begin()
    expect(bridge.pause).toHaveBeenCalledOnce()
    expect(state.playing).toBeNull()
    expect(music.getState()).toEqual({ active: true, playerName: 'Spotify' })
    expect(changes).toHaveBeenCalledOnce()
    await music.end()
    expect(bridge.resume).toHaveBeenCalledWith(spotify.id)
    expect(state.playing).not.toBeNull()
    expect(music.getState()).toEqual({ active: false, playerName: null })
  })

  it('stays out of it when nothing was playing', async () => {
    const { bridge } = host(null)
    const music = new UserMusic({ bridge })
    await music.begin()
    expect(music.getState()).toEqual({ active: false, playerName: null })
    music.start()
    await settle()
    expect(bridge.resume).not.toHaveBeenCalled()
    await music.end()
    expect(bridge.resume).not.toHaveBeenCalled()
  })

  it('plays while the agent works and pauses again when someone speaks', async () => {
    const { bridge, state } = host(spotify)
    const music = new UserMusic({ bridge })
    await music.begin()
    music.start()
    music.start() // The hold hook polls: only the first start acts.
    await settle()
    expect(bridge.resume).toHaveBeenCalledTimes(1)
    expect(state.playing).not.toBeNull()
    music.stopImmediately()
    music.stop()
    await settle()
    expect(bridge.pause).toHaveBeenCalledTimes(2)
    expect(state.playing).toBeNull()
    music.start()
    await settle()
    expect(bridge.resume).toHaveBeenCalledTimes(2)
  })

  it('never starts a player the person paused themselves', async () => {
    const { bridge, state } = host(spotify)
    const music = new UserMusic({ bridge })
    await music.begin()
    music.start()
    await settle()
    state.playing = null // They paused it while the agent was working.
    music.stopImmediately()
    await settle()
    expect(bridge.pause).toHaveBeenCalledTimes(2)
    music.start()
    await settle()
    expect(bridge.resume).toHaveBeenCalledTimes(1)
    await music.end()
    expect(bridge.resume).toHaveBeenCalledTimes(1)
    expect(state.playing).toBeNull()
  })

  it('follows the person to another player they started meanwhile', async () => {
    const { bridge, state } = host(spotify)
    const music = new UserMusic({ bridge })
    await music.begin()
    music.start()
    await settle()
    state.playing = { id: 'com.apple.Music', name: 'Music' }
    music.stopImmediately()
    await settle()
    expect(music.getState()).toEqual({ active: true, playerName: 'Music' })
    await music.end()
    expect(bridge.resume).toHaveBeenLastCalledWith('com.apple.Music')
  })

  it('coalesces overlapping intents: the last one wins with no round trips wasted on the rest', async () => {
    const { bridge, state } = host(spotify)
    const music = new UserMusic({ bridge })
    await music.begin()
    music.start()
    music.stopImmediately()
    music.start()
    await settle()
    expect(state.playing).not.toBeNull()
    expect(bridge.resume).toHaveBeenCalledTimes(1)
    expect(bridge.pause).toHaveBeenCalledTimes(1)
    music.stopImmediately()
    music.start()
    music.stopImmediately()
    await settle()
    expect(state.playing).toBeNull()
    expect(bridge.pause).toHaveBeenCalledTimes(2)
  })

  it('ignores answers that arrive after the session they belong to ended', async () => {
    const { bridge } = host(spotify)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    ;(bridge.pause as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gate
      return { paused: spotify }
    })
    const music = new UserMusic({ bridge })
    const begun = music.begin()
    const ended = music.end()
    release()
    await Promise.all([begun, ended])
    expect(music.getState()).toEqual({ active: false, playerName: null })
    expect(bridge.resume).not.toHaveBeenCalled()
  })

  it('survives a host that cannot answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bridge: MusicBridge = {
      probe: vi.fn(async () => { throw new Error('no') }),
      pause: vi.fn(async () => { throw new Error('no') }),
      resume: vi.fn(async () => { throw new Error('no') }),
    }
    const music = new UserMusic({ bridge })
    await music.begin()
    expect(music.getState()).toEqual({ active: false, playerName: null })
    await music.end()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
