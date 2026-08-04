// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPermissionsView } from './agent-permissions-view'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  track: vi.fn(),
  apiFetch: vi.fn(),
  canAdmin: true,
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))
vi.mock('@renderer/lib/perf', () => ({ useRenderTracker: () => {} }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: mocks.track }),
}))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    isAuthMode: true,
    rolesReady: true,
    canAdminAgent: () => mocks.canAdmin,
  }),
}))

const AGENTS = [
  { slug: 'caller', displaySlug: 'caller', name: 'Caller' },
  { slug: 'target', displaySlug: 'target', name: 'Target' },
]

const POLICIES = {
  policies: [
    {
      id: 'p1',
      operation: 'read',
      targetAgentSlug: 'target',
      targetAgentName: 'Target',
      decision: 'allow',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
}

function jsonResponse(payload: unknown) {
  return { ok: true, json: async () => payload }
}

function renderView(agentSlug = 'caller') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AgentPermissionsView agentSlug={agentSlug} />
    </QueryClientProvider>,
  )
}

describe('AgentPermissionsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.canAdmin = true
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/agents/caller/x-agent-policies') return jsonResponse(POLICIES)
      if (url === '/api/agents') return jsonResponse(AGENTS)
      throw new Error(`Unexpected fetch: ${url}`)
    })
  })

  it('renders global toggles and per-agent rows without the agent itself', async () => {
    renderView()
    expect(mocks.track).toHaveBeenCalledWith('agent_permissions_viewed', { agentSlug: 'caller' })

    expect(await screen.findByText('List Agents')).toBeInTheDocument()
    expect(screen.getByTestId('x-agent-policy-global-read')).toBeInTheDocument()
    expect(screen.getByTestId('x-agent-policy-global-invoke')).toBeInTheDocument()

    // Only the OTHER workspace agent gets a row; the stored 'allow' decision
    // is reflected on its Read toggle.
    expect(screen.queryByTestId('x-agent-policy-row-caller')).not.toBeInTheDocument()
    const row = screen.getByTestId('x-agent-policy-row-target')
    const readToggle = within(row).getAllByTestId('policy-toggle-allow')[0]
    expect(readToggle).toHaveAttribute('data-active', 'true')
  })

  it('PUTs the full policy set with the change applied', async () => {
    renderView()
    const globalRead = await screen.findByTestId('x-agent-policy-global-read')

    fireEvent.click(within(globalRead).getByTestId('policy-toggle-block'))

    await waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledWith(
        '/api/agents/caller/x-agent-policies',
        expect.objectContaining({ method: 'PUT' }),
      )
    })
    const putCall = mocks.apiFetch.mock.calls.find(([, init]) => init?.method === 'PUT')!
    expect(JSON.parse(putCall[1].body)).toEqual({
      policies: [
        { operation: 'read', targetSlug: 'target', decision: 'allow' },
        { operation: 'read', targetSlug: null, decision: 'block' },
      ],
    })
  })

  it('shows owner gate and does not fetch for a non-owner', () => {
    mocks.canAdmin = false
    renderView()

    expect(screen.getByTestId('agent-permissions-no-permission')).toBeInTheDocument()
    expect(screen.getByText('Owner access required')).toBeInTheDocument()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it('navigates back to the agent home', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('agent-permissions-back-button'))

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/agents/$slug',
      params: { slug: 'caller' },
    })
  })
})
