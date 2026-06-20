// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryNavigationHandler } from './history-navigation-handler'

const mockIsElectron = vi.hoisted(() => vi.fn(() => false))
const mockGetPlatform = vi.hoisted(() => vi.fn(() => 'darwin'))
const mockBack = vi.hoisted(() => vi.fn())
const mockForward = vi.hoisted(() => vi.fn())

vi.mock('@renderer/lib/env', () => ({
  isElectron: mockIsElectron,
  getPlatform: mockGetPlatform,
}))

vi.mock('@renderer/router/use-history-navigation', () => ({
  useHistoryNavigation: () => ({
    back: mockBack,
    forward: mockForward,
    canGoBack: true,
    canGoForward: true,
  }),
}))

function dispatchKeyboardEvent(init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  window.dispatchEvent(event)
  return event
}

function dispatchMouseEvent(type: 'mousedown' | 'auxclick', button: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button,
  })
  window.dispatchEvent(event)
  return event
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('__WEB__', true)
  mockIsElectron.mockReturnValue(false)
  mockGetPlatform.mockReturnValue('darwin')
  delete window.electronAPI
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HistoryNavigationHandler', () => {
  it('does not handle browser web shortcuts', () => {
    render(<HistoryNavigationHandler />)

    dispatchKeyboardEvent({ key: '[', code: 'BracketLeft', metaKey: true })
    dispatchMouseEvent('mousedown', 3)

    expect(mockBack).not.toHaveBeenCalled()
    expect(mockForward).not.toHaveBeenCalled()
  })

  it('handles Electron keyboard shortcuts', () => {
    vi.stubGlobal('__WEB__', false)
    mockIsElectron.mockReturnValue(true)
    render(<HistoryNavigationHandler />)

    const backEvent = dispatchKeyboardEvent({ key: '[', code: 'BracketLeft', metaKey: true })
    const forwardEvent = dispatchKeyboardEvent({ key: ']', code: 'BracketRight', metaKey: true })

    expect(backEvent.defaultPrevented).toBe(true)
    expect(forwardEvent.defaultPrevented).toBe(true)
    expect(mockBack).toHaveBeenCalledTimes(1)
    expect(mockForward).toHaveBeenCalledTimes(1)
  })

  it('handles Electron Alt+Arrow shortcuts', () => {
    vi.stubGlobal('__WEB__', false)
    mockIsElectron.mockReturnValue(true)
    mockGetPlatform.mockReturnValue('win32')
    render(<HistoryNavigationHandler />)

    dispatchKeyboardEvent({ key: 'ArrowLeft', altKey: true })
    dispatchKeyboardEvent({ key: 'ArrowRight', altKey: true })

    expect(mockBack).toHaveBeenCalledTimes(1)
    expect(mockForward).toHaveBeenCalledTimes(1)
  })

  it('handles Electron auxiliary mouse buttons', () => {
    vi.stubGlobal('__WEB__', false)
    mockIsElectron.mockReturnValue(true)
    render(<HistoryNavigationHandler />)

    const backEvent = dispatchMouseEvent('mousedown', 3)
    const forwardEvent = dispatchMouseEvent('auxclick', 4)

    expect(backEvent.defaultPrevented).toBe(true)
    expect(forwardEvent.defaultPrevented).toBe(true)
    expect(mockBack).toHaveBeenCalledTimes(1)
    expect(mockForward).toHaveBeenCalledTimes(1)
  })

  it('handles native app-command events forwarded by preload', () => {
    vi.stubGlobal('__WEB__', false)
    mockIsElectron.mockReturnValue(true)
    let nativeCallback: ((command: 'back' | 'forward') => void) | null = null
    const unsubscribe = vi.fn()
    window.electronAPI = {
      onHistoryNavigationCommand: vi.fn((callback) => {
        nativeCallback = callback
        return unsubscribe
      }),
    } as unknown as typeof window.electronAPI

    const { unmount } = render(<HistoryNavigationHandler />)

    act(() => {
      nativeCallback?.('back')
      nativeCallback?.('forward')
    })

    expect(mockBack).toHaveBeenCalledTimes(1)
    expect(mockForward).toHaveBeenCalledTimes(1)

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
