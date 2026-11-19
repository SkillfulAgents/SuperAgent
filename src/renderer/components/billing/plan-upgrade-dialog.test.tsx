// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { isDeniedByPlan, PLATFORM_PLAN_UPGRADE_ACTION } from '@shared/lib/llm-provider/platform-plan-policy'
import { PLATFORM_CATALOG } from '@shared/lib/llm-provider/builtin-catalogs'

const state = vi.hoisted(() => ({
  electron: false,
  auth: { role: 'owner' as string | null, platformControlled: true, orgId: 'org_1', platformBaseUrl: 'https://platform.example.com' },
  denied: ['claude-fable-', 'gpt-6-astra'] as string[],
  updatedAt: 0,
  pending: null as null | { toPlan: { id: string; name: string }; effectiveAt: string },
  refresh: vi.fn(async () => {}),
  openExternal: vi.fn(async () => {}),
}))

vi.mock('@renderer/lib/env', () => ({ isElectron: () => state.electron }))
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl: state.openExternal }))
vi.mock('@renderer/hooks/use-platform-auth', () => ({ usePlatformAuthStatus: () => ({ data: state.auth }) }))
vi.mock('@renderer/hooks/use-llm-connections', () => ({ useLlmConnections: () => ({ data: {
  connections: [{ id: 'platform-conn', provider: 'platform', isConfigured: true, catalog: PLATFORM_CATALOG }],
} }) }))
vi.mock('@renderer/hooks/use-provider-model-availability', () => ({ useProviderModelAvailability: () => ({
  isUnavailable: (model: { id: string }) => isDeniedByPlan(state.denied, model.id),
  updatedAt: state.updatedAt,
}) }))
vi.mock('@renderer/hooks/use-platform-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/hooks/use-platform-plan')>()),
  usePlatformPlan: () => ({
    plan: { id: 'pro-30', name: 'Pro 30', deniedModels: state.denied },
    pendingPlanChange: state.pending,
    excludedLabel: state.denied.length ? 'Claude Fable and GPT Astra' : null,
    refresh: state.refresh,
  }),
}))

import { PlanUpgradeDialog } from './plan-upgrade-dialog'

const BILLING_URL = 'https://platform.example.com/dashboard/organizations/org_1?tab=billing'
const ACTION = { component: PLATFORM_PLAN_UPGRADE_ACTION, label: 'Upgrade', href: BILLING_URL }
const FABLE = { action: ACTION, model: { id: 'claude-fable-5-1', label: 'Fable 5.1' }, connectionId: 'platform-conn' }
const ASTRA = { action: ACTION, model: { id: 'gpt-6-astra', label: 'GPT-6 Astra' }, connectionId: 'platform-conn' }

beforeEach(() => {
  state.electron = false
  state.auth = { role: 'owner', platformControlled: true, orgId: 'org_1', platformBaseUrl: 'https://platform.example.com' }
  state.denied = ['claude-fable-', 'gpt-6-astra']
  state.updatedAt = 0
  state.pending = null
  state.refresh.mockClear()
  state.openExternal.mockClear()
})

describe('PlanUpgradeDialog', () => {
  it('frames the full billing page on a cloud workspace, for the model that prompted it', () => {
    render(<PlanUpgradeDialog request={FABLE} onClose={vi.fn()} />)
    expect(screen.getByText('Upgrade to use Fable 5.1')).toBeInTheDocument()
    expect(screen.getByText("Fable 5.1 isn't included in your Pro 30 plan. Upgrade the plan to use it.")).toBeInTheDocument()
    const src = new URL(screen.getByTestId('billing-embed-frame').getAttribute('src')!)
    expect(src.pathname).toBe('/embed/billing/org_1')
    expect(src.searchParams.has('view')).toBe(false)
    // The plan is re-read on open.
    expect(state.refresh).toHaveBeenCalled()
  })

  it('hands off to the browser on Electron and re-reads the plan when the window regains focus', async () => {
    state.electron = true
    const user = userEvent.setup()
    render(<PlanUpgradeDialog request={ASTRA} onClose={vi.fn()} />)
    expect(screen.queryByTestId('billing-embed-frame')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Open billing/ }))
    expect(state.openExternal).toHaveBeenCalledWith(BILLING_URL)
    expect(screen.getByTestId('plan-upgrade-waiting')).toBeInTheDocument()
    state.refresh.mockClear()
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(state.refresh).toHaveBeenCalled()
  })

  it('tells members to ask an admin instead of offering billing they cannot use', () => {
    state.auth = { ...state.auth, role: 'member' }
    render(<PlanUpgradeDialog request={FABLE} onClose={vi.fn()} />)
    expect(screen.getByText(/Ask a workspace owner or admin to upgrade the plan/)).toBeInTheDocument()
    expect(screen.queryByTestId('billing-embed-frame')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open billing/ })).not.toBeInTheDocument()
  })

  it('says billing includes the model while access catches up, and re-reads on close', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<PlanUpgradeDialog request={FABLE} onClose={onClose} />)
    state.denied = []
    state.updatedAt = Date.now() + 1000
    rerender(<PlanUpgradeDialog request={FABLE} onClose={onClose} />)
    expect(screen.getByText('Your plan now includes Fable 5.1')).toBeInTheDocument()
    expect(screen.getByText(/Model access may take a moment to update/)).toBeInTheDocument()
    state.refresh.mockClear()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(state.refresh).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('describes the current plan and any scheduled switch for Change plan', () => {
    state.pending = { toPlan: { id: 'pro-30', name: 'Pro 30' }, effectiveAt: '2026-11-13T12:00:00Z' }
    render(<PlanUpgradeDialog request={{ action: ACTION }} onClose={vi.fn()} />)
    expect(screen.getByText('Change plan')).toBeInTheDocument()
    expect(screen.getByText('Your workspace is on Pro 30, which excludes Claude Fable and GPT Astra. Switching to Pro 30 on Nov 13.')).toBeInTheDocument()
  })
})
