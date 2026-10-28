// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'

import { PlatformBillingInfoSchema } from '@shared/lib/types/skillset-schema'

const state = vi.hoisted(() => ({
  auth: {
    connected: true,
    platformBaseUrl: 'https://platform.example.com',
    orgId: 'org_a',
    userId: 'user_a' as string | null,
    memberId: 'member_a' as string | null,
    updatedAt: '2026-10-13T10:00:00Z' as string | null,
  },
  fetchBilling: vi.fn(),
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({ usePlatformAuthStatus: () => ({ data: state.auth }) }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: () => state.fetchBilling() }))

import { usePlatformPlan } from './use-platform-plan'

const OLD_BILLING = PlatformBillingInfoSchema.parse({
  configured: true,
  subscription: { status: 'active', paymentStatus: 'current' },
  seat: null,
  orgPool: { poolBalanceCents: 0 },
})
const RESTRICTED_BILLING = PlatformBillingInfoSchema.parse({
  ...OLD_BILLING,
  plan: { id: 'pro-30', name: 'Pro 30', deniedModels: ['claude-fable-'] },
  deniedModels: ['claude-fable-'],
})

function response(billing: typeof OLD_BILLING) {
  // The server words what the plan excludes; the hook never reads the denylist.
  const excludedModels = billing.plan ? 'Claude Fable' : null
  return { ok: true, json: async () => ({ connected: true, billing, excludedModels }) } as Response
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children)
  }
}

function renderPlan() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(() => usePlatformPlan(), { wrapper: wrapper(client) })
}

beforeEach(() => {
  state.auth = {
    connected: true,
    platformBaseUrl: 'https://platform.example.com',
    orgId: 'org_a',
    userId: 'user_a',
    memberId: 'member_a',
    updatedAt: '2026-10-13T10:00:00Z',
  }
  state.fetchBilling.mockReset()
})

describe('usePlatformPlan billing identity', () => {
  it.each([
    ['another workspace', { orgId: 'org_b' }],
    ['another member in the same workspace', { memberId: 'member_b' }],
    ['another platform host', { platformBaseUrl: 'https://other-platform.example.com' }],
    ['a reconnected credential', { updatedAt: '2026-10-13T11:00:00Z' }],
  ])('does not show a cached plan for %s', async (_case, change) => {
    state.fetchBilling.mockResolvedValueOnce(response(RESTRICTED_BILLING))
    const view = renderPlan()
    await waitFor(() => expect(view.result.current.excludedLabel).toBe('Claude Fable'))

    let resolveNext: ((value: Response) => void) | undefined
    state.fetchBilling.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveNext = resolve }))
    state.auth = { ...state.auth, ...change }
    view.rerender()

    expect(view.result.current.plan).toBeNull()
    expect(view.result.current.excludedLabel).toBeNull()
    resolveNext?.(response(OLD_BILLING))
    await waitFor(() => expect(view.result.current.updatedAt).toBeGreaterThan(0))
    expect(state.fetchBilling).toHaveBeenCalledTimes(2)
  })

  it('leaves an older billing API with no plan fields unrestricted', async () => {
    state.fetchBilling.mockResolvedValue(response(OLD_BILLING))
    const view = renderPlan()
    await waitFor(() => expect(view.result.current.updatedAt).toBeGreaterThan(0))
    expect(view.result.current.plan).toBeNull()
    expect(view.result.current.excludedLabel).toBeNull()
  })

  it('drops a cached plan when the platform disconnects', async () => {
    state.fetchBilling.mockResolvedValue(response(RESTRICTED_BILLING))
    const view = renderPlan()
    await waitFor(() => expect(view.result.current.excludedLabel).toBe('Claude Fable'))
    state.auth = { ...state.auth, connected: false }
    view.rerender()
    expect(view.result.current.plan).toBeNull()
    expect(view.result.current.excludedLabel).toBeNull()
  })
})
