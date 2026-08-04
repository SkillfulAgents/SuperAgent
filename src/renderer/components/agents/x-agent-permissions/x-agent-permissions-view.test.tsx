// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { XAgentPermissionsView } from './x-agent-permissions-view'

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
  { slug: 'helper', displaySlug: 'helper', name: 'Helper' },
]

function policy(operation: string, targetAgentSlug: string | null, decision: string) {
  return {
    id: `${operation}-${targetAgentSlug ?? 'global'}`,
    operation,
    targetAgentSlug,
    targetAgentName: targetAgentSlug,
    decision,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

let policies: ReturnType<typeof policy>[]

function jsonResponse(payload: unknown) {
  return { ok: true, json: async () => payload }
}

function renderView(agentSlug = 'caller') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <XAgentPermissionsView agentSlug={agentSlug} />
    </QueryClientProvider>,
  )
}

function lastPutBody() {
  const putCall = mocks.apiFetch.mock.calls.findLast(([, init]) => init?.method === 'PUT')
  expect(putCall).toBeDefined()
  return JSON.parse(putCall![1].body)
}

describe('XAgentPermissionsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.canAdmin = true
    policies = [policy('invoke', 'target', 'allow'), policy('read', 'target', 'allow')]
    mocks.apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/agents/caller/x-agent-policies' && (!init || !init.method)) {
        return jsonResponse({ policies })
      }
      if (url === '/api/agents/caller/x-agent-policies' && init?.method === 'PUT') {
        return jsonResponse({ ok: true })
      }
      if (url === '/api/agents') return jsonResponse(AGENTS)
      throw new Error(`Unexpected fetch: ${url}`)
    })
  })

  it('splits agents into Connected / Not connected by their effective send policy', async () => {
    renderView()
    expect(mocks.track).toHaveBeenCalledWith('agent_permissions_viewed', { agentSlug: 'caller' })

    // Globals stay on top.
    expect(await screen.findByText('Allow this agent to see a list of all other agents')).toBeInTheDocument()
    expect(screen.getByTestId('x-agent-policy-global-read')).toBeInTheDocument()
    expect(screen.getByTestId('x-agent-policy-global-invoke')).toBeInTheDocument()

    // Target (invoke allow) is connected; Helper is not; the caller has no row.
    expect(screen.queryByTestId('x-agent-policy-row-caller')).not.toBeInTheDocument()
    const targetSwitch = screen.getByTestId('x-agent-connect-switch-target')
    const helperSwitch = screen.getByTestId('x-agent-connect-switch-helper')
    expect(targetSwitch).toHaveAttribute('aria-checked', 'true')
    expect(helperSwitch).toHaveAttribute('aria-checked', 'false')

    // Connected rows carry a Permissions popover trigger; not-connected rows don't.
    expect(screen.getByTestId('x-agent-permissions-trigger-target')).toBeInTheDocument()
    expect(screen.queryByTestId('x-agent-permissions-trigger-helper')).not.toBeInTheDocument()
  })

  it('connect flow: toggling on grants Send immediately', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('x-agent-connect-switch-helper'))

    await waitFor(() => {
      expect(lastPutBody()).toEqual({
        policies: [
          { operation: 'invoke', targetSlug: 'target', decision: 'allow' },
          { operation: 'read', targetSlug: 'target', decision: 'allow' },
          { operation: 'invoke', targetSlug: 'helper', decision: 'allow' },
        ],
      })
    })
    // The row lands in Connected with its Permissions trigger available.
    expect(await screen.findByTestId('x-agent-permissions-trigger-helper')).toBeInTheDocument()
  })

  it('disconnect removes the explicit send grant and keeps read untouched', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('x-agent-connect-switch-target'))

    await waitFor(() => {
      expect(lastPutBody()).toEqual({
        policies: [{ operation: 'read', targetSlug: 'target', decision: 'allow' }],
      })
    })
  })

  it('disconnecting an agent connected only via the global default pins an explicit Review', async () => {
    policies = [policy('invoke', null, 'allow')]
    renderView()

    // Both agents inherit connected from the global send=allow.
    const helperSwitch = await screen.findByTestId('x-agent-connect-switch-helper')
    expect(helperSwitch).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(helperSwitch)
    await waitFor(() => {
      expect(lastPutBody()).toEqual({
        policies: [
          { operation: 'invoke', targetSlug: null, decision: 'allow' },
          { operation: 'invoke', targetSlug: 'helper', decision: 'review' },
        ],
      })
    })
  })

  it('the Permissions popover on a connected row saves a fine-grained change', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('x-agent-permissions-trigger-target'))

    const popover = screen.getByTestId('x-agent-permissions-popover-target')
    // Read is the first control; open its dropdown and pick Block (the menu
    // renders in a portal, so query at screen level).
    fireEvent.click(within(popover).getAllByTestId('policy-dropdown-trigger')[0])
    fireEvent.click(await screen.findByTestId('policy-menu-block'))

    await waitFor(() => {
      expect(lastPutBody()).toEqual({
        policies: [
          { operation: 'invoke', targetSlug: 'target', decision: 'allow' },
          { operation: 'read', targetSlug: 'target', decision: 'block' },
        ],
      })
    })
  })

  it('badges an explicitly blocked agent in the list', async () => {
    policies = [policy('invoke', 'target', 'block')]
    renderView()

    const row = await screen.findByTestId('x-agent-policy-row-target')
    expect(within(row).getByText('Blocked')).toBeInTheDocument()
    expect(within(row).getByTestId('x-agent-connect-switch-target')).toHaveAttribute('aria-checked', 'false')
  })

  it('shows owner gate and does not fetch for a non-owner', () => {
    mocks.canAdmin = false
    renderView()

    expect(screen.getByTestId('x-agent-permissions-no-permission')).toBeInTheDocument()
    expect(screen.getByText('Owner access required')).toBeInTheDocument()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it('navigates back to the agent home', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('x-agent-permissions-back-button'))

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/agents/$slug',
      params: { slug: 'caller' },
    })
  })
})
