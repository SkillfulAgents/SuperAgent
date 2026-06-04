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

  it('treats saved baseline label defaults as NOT custom', async () => {
    // '*read'=allow, '*write'=review, '*destructive'=block is the recommended
    // baseline — saving it as-is should not flip the pill to "Custom".
    mockPoliciesResponse([
      { scope: '*read', decision: 'allow' },
      { scope: '*write', decision: 'review' },
      { scope: '*destructive', decision: 'block' },
    ])
    renderWithProviders(<PolicySummaryPill accountId="acc-base" />)
    await waitFor(() => {
      expect(screen.getByText('Protected')).toBeInTheDocument()
    })
    expect(screen.queryByText('Protected • Custom')).not.toBeInTheDocument()
  })

  it('shows "Custom" when a label default deviates from the baseline', async () => {
    // '*destructive'=allow deviates from the baseline (block) → custom.
    mockPoliciesResponse([
      { scope: '*read', decision: 'allow' },
      { scope: '*destructive', decision: 'allow' },
    ])
    renderWithProviders(<PolicySummaryPill accountId="acc-dev" />)
    await waitFor(() => {
      expect(screen.getByText('Protected • Custom')).toBeInTheDocument()
    })
  })

  it('shows "Custom" when a real per-scope policy is mixed with baseline labels', async () => {
    mockPoliciesResponse([
      { scope: '*read', decision: 'allow' }, // baseline, discounted
      { scope: 'chat:write', decision: 'block' }, // real override → custom
    ])
    renderWithProviders(<PolicySummaryPill accountId="acc-mix" />)
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
