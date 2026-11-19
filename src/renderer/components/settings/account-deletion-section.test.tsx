// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/api', () => ({ apiFetch: apiFetchMock }))

import { AccountDeletionSection } from './account-deletion-section'

const REQUEST_ID = '0b0e2c1a-1111-4222-8333-444455556666'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AccountDeletionSection userId="user-1" email="ada@example.com" />
    </QueryClientProvider>,
  )
}

/** The calls that sent a request, as opposed to reading the status. */
function posts() {
  return apiFetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
}

describe('AccountDeletionSection', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('offers nothing where there is no account to delete', async () => {
    apiFetchMock.mockResolvedValue(json({ available: false, request: null }))
    renderSection()

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled())
    expect(screen.queryByTestId('account-deletion-section')).toBeNull()
  })

  it('sends nothing until the person confirms, and nothing when they cancel', async () => {
    apiFetchMock.mockResolvedValue(json({ available: true, request: null }))
    renderSection()

    await userEvent.click(await screen.findByTestId('account-deletion-request'))
    expect(screen.getByText(/This requests deletion for ada@example\.com/)).toBeTruthy()
    expect(screen.getByText(/sent through\s+Amplitude/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(posts()).toHaveLength(0)
  })

  it('sends the request for the account shown, then shows it as sent with its id', async () => {
    apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? json({ available: true, request: { requestId: REQUEST_ID, requestedAt: 1, accepted: true } })
        : json({ available: true, request: null }),
    )
    renderSection()

    await userEvent.click(await screen.findByTestId('account-deletion-request'))
    await userEvent.click(screen.getByTestId('account-deletion-confirm'))

    expect(await screen.findByText('Deletion request sent')).toBeTruthy()
    expect(screen.getByTestId('account-deletion-request-id').textContent).toBe(REQUEST_ID)
    expect(screen.queryByTestId('account-deletion-request')).toBeNull()
    expect(posts()).toHaveLength(1)
    expect(JSON.parse(String(posts()[0][1].body))).toEqual({ userId: 'user-1' })
  })

  it('shows a failed send with the request id it will retry with', async () => {
    let sent = false
    apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        sent = true
        return json({ error: "We couldn't confirm delivery of your request. Please try again." }, 502)
      }
      return json({
        available: true,
        request: sent ? { requestId: REQUEST_ID, requestedAt: 1, accepted: false } : null,
      })
    })
    renderSection()

    await userEvent.click(await screen.findByTestId('account-deletion-request'))
    await userEvent.click(screen.getByTestId('account-deletion-confirm'))

    expect((await screen.findByTestId('account-deletion-error')).textContent).toContain("couldn't confirm delivery")
    expect((await screen.findByTestId('account-deletion-request-id')).textContent).toBe(REQUEST_ID)
    // Still offered: trying again sends the same request.
    expect(screen.getByTestId('account-deletion-request')).toBeTruthy()
  })

  it('shows a request sent earlier without offering another', async () => {
    apiFetchMock.mockResolvedValue(json({ available: true, request: { requestId: REQUEST_ID, requestedAt: 1, accepted: true } }))
    renderSection()

    expect(await screen.findByTestId('account-deletion-sent')).toBeTruthy()
    expect(screen.queryByTestId('account-deletion-request')).toBeNull()
  })
})
