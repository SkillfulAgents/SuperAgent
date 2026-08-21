// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { DraftsProvider } from '@renderer/context/drafts-context'
import { useBrowserInputActions } from './use-browser-input-actions'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const ok = () => ({ ok: true, json: () => Promise.resolve({}) })
const COMPLETE_URL = '/api/agents/a/sessions/s/complete-browser-input'
const MESSAGES_URL = '/api/agents/a/sessions/s/messages'

function setup(onResolved = vi.fn()) {
  const view = renderHook(
    () => useBrowserInputActions({ agentSlug: 'a', sessionId: 's', onResolved }),
    { wrapper: ({ children }) => <DraftsProvider>{children}</DraftsProvider> }
  )
  return { ...view, onResolved }
}

describe('useBrowserInputActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('complete posts only the toolUseId and resolves it', async () => {
    mockApiFetch.mockResolvedValueOnce(ok())
    const { result, onResolved } = setup()

    await act(async () => {
      await result.current.complete('tu-1')
    })

    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockApiFetch.mock.calls[0][0]).toBe(COMPLETE_URL)
    expect(JSON.parse(mockApiFetch.mock.calls[0][1].body)).toEqual({ toolUseId: 'tu-1' })
    expect(result.current.status).toBe('completed')
    expect(onResolved).toHaveBeenCalledWith('tu-1')
  })

  it('decline with no reason posts only the decline, no /messages', async () => {
    mockApiFetch.mockResolvedValueOnce(ok())
    const { result, onResolved } = setup()

    await act(async () => {
      await result.current.decline('tu-1')
    })

    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(mockApiFetch.mock.calls[0][1].body)).toEqual({ toolUseId: 'tu-1', decline: true })
    expect(result.current.status).toBe('declined')
    expect(onResolved).toHaveBeenCalledWith('tu-1')
  })

  it('decline with a reason declines, then posts the reason to /messages in order', async () => {
    mockApiFetch.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok())
    const { result } = setup()

    await act(async () => {
      await result.current.decline('tu-1', 'skip the login')
    })

    expect(mockApiFetch).toHaveBeenCalledTimes(2)
    expect(mockApiFetch.mock.calls[0][0]).toBe(COMPLETE_URL)
    expect(JSON.parse(mockApiFetch.mock.calls[0][1].body)).toEqual({ toolUseId: 'tu-1', decline: true })
    expect(mockApiFetch.mock.calls[1][0]).toBe(MESSAGES_URL)
    expect(JSON.parse(mockApiFetch.mock.calls[1][1].body)).toEqual({ content: 'skip the login' })
  })

  it('when the decline itself fails, it never posts the reason and reverts to pending', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'decline boom' }),
    })
    const { result, onResolved } = setup()

    await act(async () => {
      await result.current.decline('tu-1', 'skip the login')
    })

    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('pending')
    expect(result.current.error).toMatch(/decline boom/)
    expect(onResolved).not.toHaveBeenCalled()
  })
})
