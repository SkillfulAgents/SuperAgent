// @vitest-environment jsdom
import { fakeLoginWindow } from '@renderer/test/fake-login-window'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))

import { LOGIN_WINDOW_CANCEL_DELAY_MS, useLoginWindow, type LoginWindowOutcome } from './use-login-window'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('useLoginWindow', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Cleared before each test, not after: unmounting the previous test's hook
  // closes its window, and that call must not count toward the next test.
  beforeEach(() => {
    fakeLoginWindow.prepare.mockClear()
    fakeLoginWindow.navigate.mockClear()
    fakeLoginWindow.close.mockClear()
  })

  it('opens the window before the URL request settles, then sends it to the login page', async () => {
    const { result } = renderHook(() => useLoginWindow())
    const request = deferred<string>()

    let windowsOpenAtRequest = -1
    let outcome!: Promise<LoginWindowOutcome>
    act(() => {
      outcome = result.current.open(() => {
        windowsOpenAtRequest = fakeLoginWindow.prepare.mock.calls.length
        return request.promise
      })
    })
    // Inside the click: the window exists before the request even starts.
    expect(windowsOpenAtRequest).toBe(1)
    expect(result.current.pending).toBe(true)
    expect(result.current.waiting).toBe(false)

    request.resolve('https://login.test')
    await act(async () => { await outcome })
    await expect(outcome).resolves.toBe('waiting')
    expect(fakeLoginWindow.navigate).toHaveBeenCalledWith('https://login.test')
    expect(result.current.waiting).toBe(true)
  })

  it('reveals Cancel 10 s after the click, and close() closes the window and resets', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useLoginWindow())
    // The URL request never settles: the clock runs from the click.
    act(() => { void result.current.open(() => new Promise<string>(() => {})) })

    act(() => { vi.advanceTimersByTime(LOGIN_WINDOW_CANCEL_DELAY_MS - 1) })
    expect(result.current.canCancel).toBe(false)
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current.canCancel).toBe(true)

    act(() => { result.current.close() })
    expect(fakeLoginWindow.close).toHaveBeenCalledTimes(1)
    expect(result.current).toMatchObject({ pending: false, waiting: false, canCancel: false })
  })

  it('drops a response that lands after Cancel', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useLoginWindow())
    const request = deferred<string>()

    let outcome!: Promise<LoginWindowOutcome>
    act(() => { outcome = result.current.open(() => request.promise) })
    act(() => { result.current.close() })

    request.resolve('https://login.test')
    await act(async () => { await outcome })
    await expect(outcome).resolves.toBe('stale')
    expect(fakeLoginWindow.navigate).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(false)
    // The canceled attempt's timer is gone too.
    act(() => { vi.advanceTimersByTime(LOGIN_WINDOW_CANCEL_DELAY_MS) })
    expect(result.current.canCancel).toBe(false)
  })

  it('lets an older attempt fail late without touching the attempt started after it', async () => {
    const { result } = renderHook(() => useLoginWindow())
    const first = deferred<string>()

    let firstOutcome!: Promise<LoginWindowOutcome>
    act(() => { firstOutcome = result.current.open(() => first.promise) })
    await act(async () => { await result.current.open(async () => 'https://login.test/second') })

    first.reject(new Error('late failure'))
    await act(async () => { await firstOutcome })
    await expect(firstOutcome).resolves.toBe('stale')
    expect(result.current.waiting).toBe(true)
    expect(fakeLoginWindow.navigate).toHaveBeenCalledTimes(1)
  })

  it('closes the window and rethrows when the request fails', async () => {
    const { result } = renderHook(() => useLoginWindow())

    let outcome!: Promise<LoginWindowOutcome>
    act(() => { outcome = result.current.open(async () => { throw new Error('no login url') }) })
    await act(async () => { await outcome.catch(() => {}) })

    await expect(outcome).rejects.toThrow('no login url')
    expect(fakeLoginWindow.close).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBe(false)
  })

  it('closes the window and rethrows when the window cannot be sent to the login page', async () => {
    fakeLoginWindow.navigate.mockRejectedValueOnce(new Error('openExternal failed'))
    const { result } = renderHook(() => useLoginWindow())

    let outcome!: Promise<LoginWindowOutcome>
    act(() => { outcome = result.current.open(async () => 'https://login.test') })
    await act(async () => { await outcome.catch(() => {}) })

    await expect(outcome).rejects.toThrow('openExternal failed')
    expect(fakeLoginWindow.close).toHaveBeenCalledTimes(1)
    expect(result.current).toMatchObject({ pending: false, waiting: false })
  })

  it('closes the window when the request returns no URL', async () => {
    const { result } = renderHook(() => useLoginWindow())

    let outcome!: LoginWindowOutcome
    await act(async () => { outcome = await result.current.open(async () => null) })

    expect(outcome).toBe('no-url')
    expect(fakeLoginWindow.close).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBe(false)
  })

  it('closes the window on unmount', async () => {
    const { result, unmount } = renderHook(() => useLoginWindow())
    await act(async () => { await result.current.open(async () => 'https://login.test') })

    unmount()
    expect(fakeLoginWindow.close).toHaveBeenCalledTimes(1)
  })
})
