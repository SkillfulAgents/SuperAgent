// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeConnections } from './home-connections'
import { renderWithProviders } from '@renderer/test/test-utils'

// Mock apiFetch so the real `useAgentConnectedAccounts` hook runs end-to-end
// against a fake network.
const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

// Capture setView so we can assert on the deep link into the connections page.
const mockSetView = vi.fn()
vi.mock('@renderer/context/selection-context', () => ({
  useSelection: () => ({
    view: { kind: 'home' },
    setView: mockSetView,
    setAgent: vi.fn(),
    consumePendingDraft: vi.fn(() => null),
  }),
  SelectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const ACCOUNT = {
  id: 'acc-1',
  providerConnectionId: 'conn-1',
  providerName: 'composio',
  toolkitSlug: 'github',
  displayName: 'My GitHub Account',
  status: 'active' as const,
  createdAt: new Date('2025-01-01').toISOString(),
  updatedAt: new Date('2025-01-01').toISOString(),
  mappingId: 'map-1',
  mappedAt: new Date('2025-01-01').toISOString(),
  provider: { slug: 'github', displayName: 'GitHub' },
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response
}

describe('HomeConnections — row navigation', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
    mockSetView.mockReset()

    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (path === '/api/agents/test-agent/connected-accounts' && method === 'GET') {
        return Promise.resolve(jsonResponse({ accounts: [ACCOUNT] }))
      }
      if (path === '/api/agents/test-agent/remote-mcps' && method === 'GET') {
        return Promise.resolve(jsonResponse({ mcps: [] }))
      }
      throw new Error(`Unexpected request: ${method} ${path}`)
    })
  })

  it('deep-links to the connection detail view when a row is activated', async () => {
    const user = userEvent.setup()
    renderWithProviders(<HomeConnections agentSlug="test-agent" />)

    // Wait for initial load — the account row appears (name = provider display name).
    expect(await screen.findByText('GitHub')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open GitHub connection details' }))

    // The row key matches the UnifiedRow key format used by the connections page.
    expect(mockSetView).toHaveBeenCalledWith({
      kind: 'connections',
      detailRowKey: 'account-acc-1',
    })
  })

  it('opens the connections page (no deep link) from the Manage Connections button', async () => {
    const user = userEvent.setup()
    renderWithProviders(<HomeConnections agentSlug="test-agent" />)

    expect(await screen.findByText('GitHub')).toBeInTheDocument()

    await user.click(screen.getByTestId('home-connections-open-page'))

    expect(mockSetView).toHaveBeenCalledWith({ kind: 'connections' })
  })
})
