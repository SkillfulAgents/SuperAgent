// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { fakeLoginWindow } from '@renderer/test/fake-login-window'
import { useMcpLoginWindow } from './use-mcp-login-window'

vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))

function postCallback(state: string) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mcp-oauth-callback', success: true, state },
    }))
  })
}

describe('useMcpLoginWindow', () => {
  it('completes only on this attempt\'s callback, ignoring another tab\'s', async () => {
    delete (window as { electronAPI?: unknown }).electronAPI
    const onComplete = vi.fn()
    const { result } = renderHook(() => useMcpLoginWindow(onComplete))

    await act(async () => {
      await result.current.open(async () => ({ redirectUrl: 'https://auth.example.com', state: 'mine' }))
    })
    postCallback('other-tab')
    expect(onComplete).not.toHaveBeenCalled()

    postCallback('mine')
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ success: true, state: 'mine' }))
  })

  it('forgets a cancelled attempt\'s state before the retry reaches its sign-in page', async () => {
    delete (window as { electronAPI?: unknown }).electronAPI
    const onComplete = vi.fn()
    const { result } = renderHook(() => useMcpLoginWindow(onComplete))

    await act(async () => {
      await result.current.open(async () => ({ redirectUrl: 'https://auth.example.com', state: 'A' }))
    })
    act(() => result.current.close())

    // The retry's window is still navigating: it is waiting, but its state is not known yet.
    let landOnSignIn!: () => void
    fakeLoginWindow.navigate.mockImplementationOnce(() => new Promise<void>((resolve) => { landOnSignIn = resolve }))
    let retry!: Promise<unknown>
    act(() => { retry = result.current.open(async () => ({ redirectUrl: 'https://auth.example.com', state: 'B' })) })
    await act(async () => {})
    postCallback('A')
    expect(onComplete).not.toHaveBeenCalled()

    await act(async () => { landOnSignIn(); await retry })
    postCallback('B')
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ state: 'B' }))
  })
})
