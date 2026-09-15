// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const music = vi.hoisted(() => {
  let state = { active: false, playerName: null as string | null }
  const listeners = new Set<() => void>()
  return {
    begin: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: { active: boolean; playerName: string | null }) { state = next; for (const l of listeners) l() },
  }
})
vi.mock('@renderer/lib/speech/user-music', () => ({ userMusic: music }))
const env = vi.hoisted(() => ({ electron: true, platform: 'darwin' as string | undefined }))
vi.mock('@renderer/lib/env', () => ({ isElectron: () => env.electron, getPlatform: () => env.platform }))
const settings = vi.hoisted(() => ({ voice: {} as { userMusic?: boolean } }))
vi.mock('./use-user-settings', () => ({ useUserSettings: () => ({ data: settings }) }))

import { useUserMusicPreference, useUserMusicSession, useUserMusicState, userMusicSupported } from './use-user-music'

describe('userMusicSupported', () => {
  it('is a question about this window, on the platforms with a backend', () => {
    env.electron = true
    env.platform = 'darwin'
    expect(userMusicSupported()).toBe(true)
    env.platform = 'linux'
    expect(userMusicSupported()).toBe(true)
    env.platform = 'win32'
    expect(userMusicSupported()).toBe(false)
    env.platform = 'darwin'
    env.electron = false
    expect(userMusicSupported()).toBe(false)
  })
})

describe('useUserMusicPreference', () => {
  it('is on until turned off', () => {
    settings.voice = {}
    expect(renderHook(() => useUserMusicPreference()).result.current).toBe(true)
    settings.voice = { userMusic: false }
    expect(renderHook(() => useUserMusicPreference()).result.current).toBe(false)
  })
})

describe('useUserMusicSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    music.set({ active: false, playerName: null })
  })

  it('begins when enabled, ends when disabled or unmounted, and reflects what was taken', () => {
    const { result, rerender, unmount } = renderHook(({ enabled }) => useUserMusicSession(enabled), { initialProps: { enabled: false } })
    expect(music.begin).not.toHaveBeenCalled()
    rerender({ enabled: true })
    expect(music.begin).toHaveBeenCalledOnce()
    act(() => music.set({ active: true, playerName: 'Spotify' }))
    expect(result.current).toEqual({ active: true, playerName: 'Spotify' })
    rerender({ enabled: false })
    expect(music.end).toHaveBeenCalledOnce()
    rerender({ enabled: true })
    unmount()
    expect(music.begin).toHaveBeenCalledTimes(2)
    expect(music.end).toHaveBeenCalledTimes(2)
  })

  it('exposes the state alone to controls that must not start a session', () => {
    const { result } = renderHook(() => useUserMusicState())
    expect(music.begin).not.toHaveBeenCalled()
    act(() => music.set({ active: true, playerName: 'Music' }))
    expect(result.current.playerName).toBe('Music')
  })
})
