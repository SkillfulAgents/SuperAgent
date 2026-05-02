// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PolicySummaryPill } from './policy-summary-pill'
import { renderWithProviders, screen, waitFor } from '@renderer/test/test-utils'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

function mockPoliciesResponse(policies: Array<{ scope: string; decision: string }>) {
  mockApiFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ policies }),
  })
}

describe('PolicySummaryPill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows "Protected" when no policies exist', async () => {
    mockPoliciesResponse([])
    renderWithProviders(<PolicySummaryPill accountId="acc-1" />)
    await waitFor(() => {
      expect(screen.getByText('Protected')).toBeInTheDocument()
    })
    expect(screen.queryByText('Protected • Custom')).not.toBeInTheDocument()
  })

  it('shows "Protected • Custom" when any scope policy exists', async () => {
    mockPoliciesResponse([{ scope: 'read', decision: 'allow' }])
    renderWithProviders(<PolicySummaryPill accountId="acc-2" />)
    await waitFor(() => {
      expect(screen.getByText('Protected • Custom')).toBeInTheDocument()
    })
  })

  it('shows "Protected • Custom" when the account default (*) is set', async () => {
    mockPoliciesResponse([{ scope: '*', decision: 'review' }])
    renderWithProviders(<PolicySummaryPill accountId="acc-3" />)
    await waitFor(() => {
      expect(screen.getByText('Protected • Custom')).toBeInTheDocument()
    })
  })

  it('calls onClick when the pill is clicked', async () => {
    mockPoliciesResponse([])
    const onClick = vi.fn()
    renderWithProviders(<PolicySummaryPill accountId="acc-4" onClick={onClick} />)
    await waitFor(() => {
      expect(screen.getByText('Protected')).toBeInTheDocument()
    })
    screen.getByRole('button').click()
    expect(onClick).toHaveBeenCalledOnce()
  })
})
