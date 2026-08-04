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

function patchBodies() {
  return mocks.apiFetch.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String(init.body)))
}

function lastPatchBody() {
  return patchBodies().at(-1)
}

describe('XAgentPermissionsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.canAdmin = true
    policies = [policy('invoke', 'target', 'allow'), policy('read', 'target', 'allow')]
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/agents/caller/x-agent-policies' && (!init || !init.method)) {
        return jsonResponse({ policies })
      }
      if (url === '/api/agents/caller/x-agent-policies' && init?.method === 'PATCH') {
        const change = JSON.parse(String(init.body)) as {
          operation: string
          targetSlug: string | null
          decision: string
        }
        policies = policies.filter(
          (p) => p.operation !== change.operation || p.targetAgentSlug !== change.targetSlug,
        )
        if (change.decision !== 'default') {
          policies.push(policy(change.operation, change.targetSlug, change.decision))
        }
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

    // Every row carries a Permissions popover so independent Read grants remain editable.
    expect(screen.getByTestId('x-agent-permissions-trigger-target')).toBeInTheDocument()
    expect(screen.getByTestId('x-agent-permissions-trigger-helper')).toBeInTheDocument()
  })

  it('connect flow: toggling on grants Send immediately', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('x-agent-connect-switch-helper'))

    await waitFor(() => {
      expect(lastPatchBody()).toEqual({
        operation: 'invoke',
        targetSlug: 'helper',
        decision: 'allow',
      })
    })
    // The row lands in Connected with its Permissions trigger available.
    expect(await screen.findByTestId('x-agent-permissions-trigger-helper')).toBeInTheDocument()
  })

  it('disconnect removes the explicit send grant and keeps read untouched', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('x-agent-connect-switch-target'))

    await waitFor(() => {
      expect(lastPatchBody()).toEqual({
        operation: 'invoke',
        targetSlug: 'target',
        decision: 'default',
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
      expect(lastPatchBody()).toEqual({
        operation: 'invoke',
        targetSlug: 'helper',
        decision: 'review',
      })
    })
  })

  it('disconnecting an explicit allow also pins Review when the fallback is globally allowed', async () => {
    policies = [
      policy('invoke', null, 'allow'),
      policy('invoke', 'target', 'allow'),
    ]
    renderView()

    fireEvent.click(await screen.findByTestId('x-agent-connect-switch-target'))

    await waitFor(() => {
      expect(lastPatchBody()).toEqual({
        operation: 'invoke',
        targetSlug: 'target',
        decision: 'review',
      })
    })
    expect(await screen.findByTestId('x-agent-connect-switch-target')).toHaveAttribute('aria-checked', 'false')
  })

  it('sends rapid edits as independent atomic patches', async () => {
    renderView()
    const targetSwitch = await screen.findByTestId('x-agent-connect-switch-target')
    const helperSwitch = screen.getByTestId('x-agent-connect-switch-helper')

    fireEvent.click(targetSwitch)
    fireEvent.click(helperSwitch)

    await waitFor(() => {
      expect(patchBodies()).toEqual(expect.arrayContaining([
        { operation: 'invoke', targetSlug: 'target', decision: 'default' },
        { operation: 'invoke', targetSlug: 'helper', decision: 'allow' },
      ]))
      expect(patchBodies()).toHaveLength(2)
    })
    expect(mocks.apiFetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
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
      expect(lastPatchBody()).toEqual({
        operation: 'read',
        targetSlug: 'target',
        decision: 'block',
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

  it('edits Read on a disconnected row without granting Send', async () => {
    policies = [
      policy('read', 'target', 'allow'),
      policy('invoke', 'target', 'block'),
    ]
    renderView()

    expect(await screen.findByTestId('x-agent-connect-switch-target')).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByTestId('x-agent-permissions-trigger-target'))
    const popover = screen.getByTestId('x-agent-permissions-popover-target')
    fireEvent.click(within(popover).getAllByTestId('policy-dropdown-trigger')[0])
    fireEvent.click(await screen.findByTestId('policy-menu-review'))

    await waitFor(() => {
      expect(lastPatchBody()).toEqual({
        operation: 'read',
        targetSlug: 'target',
        decision: 'review',
      })
    })
    expect(patchBodies()).not.toContainEqual({
      operation: 'invoke',
      targetSlug: 'target',
      decision: 'allow',
    })
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
