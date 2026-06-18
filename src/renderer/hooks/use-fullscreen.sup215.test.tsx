// @vitest-environment jsdom
//
// SUP-215 (renderer side): the per-listener unsubscribe fix is only effective if
// each caller CAPTURES the function returned by onX and calls it on cleanup. The
// preload-level test (src/preload/index.sup215.test.ts) proves onX returns a
// working unsubscribe; these tests prove the window-state callers actually use it
// instead of a channel-wide reset. Those reset helpers (removeFullScreenChange /
// removeWindowMaximizedChange) were removed, and these channels have the most
// concurrent subscribers — useFullScreen is mounted in ~5 places, and
// window-maximized-change is shared by WindowControls + useInsetRadius — so a
// channel-wide reset here would tear down co-subscribers' listeners.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, renderHook } from '@testing-library/react'

vi.mock('@renderer/lib/env', () => ({
  isElectron: () => true,
  getPlatform: () => 'win32',
  getOSVersion: () => '10.0.22000',
}))

import { useFullScreen } from './use-fullscreen'
import { useInsetRadius } from './use-inset-radius'
import { WindowControls } from '@renderer/components/layout/window-controls'

const originalElectronAPI = window.electronAPI

afterEach(() => {
  window.electronAPI = originalElectronAPI
  vi.restoreAllMocks()
})

describe('useFullScreen — SUP-215 cleanup', () => {
  it('calls the per-listener unsubscribe returned by onFullScreenChange on unmount', () => {
    const unsubscribe = vi.fn()
    const onFullScreenChange = vi.fn(() => unsubscribe)
    window.electronAPI = {
      getFullScreenState: vi.fn().mockResolvedValue(false),
      onFullScreenChange,
    } as never

    const { unmount } = renderHook(() => useFullScreen())
    expect(onFullScreenChange).toHaveBeenCalledTimes(1)

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('useInsetRadius — SUP-215 cleanup', () => {
  it('calls the per-listener unsubscribe returned by onWindowMaximizedChange on unmount', () => {
    const unsubscribe = vi.fn()
    const onWindowMaximizedChange = vi.fn(() => unsubscribe)
    window.electronAPI = {
      // useInsetRadius nests useFullScreen, so the fullscreen channel is touched too.
      getFullScreenState: vi.fn().mockResolvedValue(false),
      onFullScreenChange: vi.fn(() => vi.fn()),
      getWindowMaximizedState: vi.fn().mockResolvedValue(false),
      onWindowMaximizedChange,
    } as never

    const { unmount } = renderHook(() => useInsetRadius())
    expect(onWindowMaximizedChange).toHaveBeenCalledTimes(1)

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('WindowControls — SUP-215 cleanup', () => {
  it('calls the per-listener unsubscribe returned by onWindowMaximizedChange on unmount', () => {
    const unsubscribe = vi.fn()
    const onWindowMaximizedChange = vi.fn(() => unsubscribe)
    window.electronAPI = {
      getWindowMaximizedState: vi.fn().mockResolvedValue(false),
      onWindowMaximizedChange,
      minimizeWindow: vi.fn(),
      toggleMaximizeWindow: vi.fn(),
      closeWindow: vi.fn(),
    } as never

    const { unmount } = render(<WindowControls />)
    expect(onWindowMaximizedChange).toHaveBeenCalledTimes(1)

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
