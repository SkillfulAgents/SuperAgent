// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import { apiFetch } from '@renderer/lib/api'
import { MobileTab } from './mobile-tab'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('react-qr-code', () => ({
  default: ({ value }: { value: string }) => <div data-testid="qr-code">{value}</div>,
}))

const mockApiFetch = vi.mocked(apiFetch)

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('MobileTab pairing QR', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'))
    mockApiFetch.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps automatic remint single-flight while the request is slow', async () => {
    let mintCalls = 0
    let resolveRefresh!: (response: Response) => void
    const pendingRefresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve
    })

    mockApiFetch.mockImplementation(async (path) => {
      if (path === '/api/auth/mobile/devices') return jsonResponse({ devices: [] })
      if (path !== '/api/auth/mobile/pairing-token') throw new Error(`Unexpected path: ${path}`)
      mintCalls += 1
      if (mintCalls === 1) {
        return jsonResponse({
          token: 'mp_initial',
          expiresAt: new Date(Date.now() + 59_000).toISOString(),
          deploymentUrl: 'https://deployment.example.com',
        })
      }
      return pendingRefresh
    })

    renderWithProviders(<MobileTab />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pairing-mint'))
      await Promise.resolve()
      await Promise.resolve()
    })

    // Rendering a code already inside the refresh window starts one refresh.
    expect(mintCalls).toBe(2)

    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    // Five interval ticks occurred while that request was pending, but none
    // were allowed to start another mint.
    expect(mintCalls).toBe(2)

    await act(async () => {
      resolveRefresh(
        jsonResponse({
          token: 'mp_refreshed',
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          deploymentUrl: 'https://deployment.example.com',
        }),
      )
      await Promise.resolve()
    })
  })
})
