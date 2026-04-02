// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PolicySummaryPill } from './policy-summary-pill'
import { renderWithProviders, screen, waitFor, within } from '@renderer/test/test-utils'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

vi.mock('@shared/lib/proxy/scope-maps', () => ({
  SCOPE_MAPS: {
    testprovider: {
      provider: 'testprovider',
      allScopes: ['read', 'write', 'admin'],
      scopeMap: [],
    },
  },
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
    renderWithProviders(
      <PolicySummaryPill accountId="acc-1" toolkit="testprovider" />
    )
    await waitFor(() => {
      expect(screen.getByText('Protected')).toBeInTheDocument()
    })
  })

  it('shows scope counts when specific scope policies exist', async () => {
    mockPoliciesResponse([
      { scope: 'read', decision: 'allow' },
      { scope: 'write', decision: 'review' },
      { scope: 'admin', decision: 'block' },
    ])
    renderWithProviders(
      <PolicySummaryPill accountId="acc-2" toolkit="testprovider" />
    )
    // Wait for query to resolve and segments to render
    await waitFor(() => {
      const pill = screen.getByTestId('policy-pill-acc-2')
      const counts = within(pill).getAllByText('1')
      expect(counts).toHaveLength(3)
    })
  })

  it('shows "All" pill when only account default is set (no specific scope policies)', async () => {
    mockPoliciesResponse([
      { scope: '*', decision: 'allow' },
    ])
    renderWithProviders(
      <PolicySummaryPill accountId="acc-3" toolkit="testprovider" />
    )
    await waitFor(() => {
      expect(screen.getByText('All')).toBeInTheDocument()
    })
    // Should NOT show "Protected" (account default is a policy)
    expect(screen.queryByText('Protected')).not.toBeInTheDocument()
  })

  it('shows scope counts alongside account default', async () => {
    mockPoliciesResponse([
      { scope: '*', decision: 'review' },
      { scope: 'read', decision: 'allow' },
      { scope: 'write', decision: 'block' },
    ])
    renderWithProviders(
      <PolicySummaryPill accountId="acc-4" toolkit="testprovider" />
    )
    await waitFor(() => {
      expect(screen.getAllByText('1')).toHaveLength(2)
    })
    // Should NOT show "All" label since specific scopes are visible
    expect(screen.queryByText('All')).not.toBeInTheDocument()
    expect(screen.queryByText('Protected')).not.toBeInTheDocument()
  })

  it('shows "Protected" when toolkit is not in scope maps and no policies exist', async () => {
    mockPoliciesResponse([])
    renderWithProviders(
      <PolicySummaryPill accountId="acc-5" toolkit="unknown-provider" />
    )
    await waitFor(() => {
      expect(screen.getByText('Protected')).toBeInTheDocument()
    })
  })

  it('calls onClick when pill is clicked', async () => {
    mockPoliciesResponse([])
    const onClick = vi.fn()
    renderWithProviders(
      <PolicySummaryPill accountId="acc-6" toolkit="testprovider" onClick={onClick} />
    )
    await waitFor(() => {
      expect(screen.getByText('Protected')).toBeInTheDocument()
    })
    screen.getByRole('button').click()
    expect(onClick).toHaveBeenCalledOnce()
  })
})
