// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useSavedLogins } from './use-saved-logins'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const respond = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) })
const login = { id: 'bc-1', name: 'example.com', site: 'example.com', capturedAt: '2026-10-01T00:00:00.000Z' }

describe('useSavedLogins', () => {
  it('keeps the request open when the login was applied but the request was not completed', async () => {
    mockApiFetch
      .mockResolvedValueOnce(respond({ logins: [login] }))
      .mockResolvedValueOnce(respond({ success: true, linked: true, requestSettled: false }))
    const { result } = renderHook(() => useSavedLogins('agent-a', 'sess-1', 'tool-1', true))
    await waitFor(() => expect(result.current.logins).toEqual([login]))

    await act(() => result.current.apply('bc-1', true))

    expect(JSON.parse(mockApiFetch.mock.calls[1][1].body)).toEqual({ toolUseId: 'tool-1', credentialId: 'bc-1', sharedAgentAcknowledged: true })
    expect(result.current).toMatchObject({
      applied: true,
      settled: false,
      error: 'Saved login applied, but the agent was not told. Click Done to continue.',
    })
  })

  it('is settled when the request was completed', async () => {
    mockApiFetch
      .mockResolvedValueOnce(respond({ logins: [login] }))
      .mockResolvedValueOnce(respond({ success: true, linked: true, requestSettled: true }))
    const { result } = renderHook(() => useSavedLogins('agent-a', 'sess-1', 'tool-1', true))
    await waitFor(() => expect(result.current.logins).toEqual([login]))

    await act(() => result.current.apply('bc-1', false))

    expect(result.current).toMatchObject({ applied: true, settled: true, error: null })
  })
})
