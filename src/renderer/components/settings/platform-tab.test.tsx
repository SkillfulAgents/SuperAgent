// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const openPlanUpgradeMock = vi.hoisted(() => vi.fn())
vi.mock('@renderer/context/plan-upgrade-context', () => ({ usePlanUpgrade: () => openPlanUpgradeMock }))

const useUserMock = vi.fn()
const platformConnectMock = vi.fn()

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => useUserMock(),
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformConnect: () => platformConnectMock(),
  useSavePlatformAccessKey: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}))

const billingInfoMock = vi.fn(() => ({ data: undefined as unknown, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }))
vi.mock('@renderer/hooks/use-billing-info', () => ({
  useBillingInfo: () => billingInfoMock(),
}))

vi.mock('@renderer/hooks/use-cloud-workspace', () => ({
  useCloudWorkspace: () => ({ data: undefined, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }),
}))

vi.mock('./profile-section', () => ({
  ProfileSection: () => <div data-testid="profile-section" />,
}))

vi.mock('./stale-agents-notice', () => ({
  StaleAgentsNotice: () => <div data-testid="stale-agents-notice" />,
}))

import { PlatformTab } from './platform-tab'

const authUser = { isAuthMode: true, isAdmin: false, user: { id: 'u1', email: 'a@example.com', name: 'Ada' } }
const localUser = { isAuthMode: false, isAdmin: false, user: null }

function disconnected() {
  return {
    handleConnect: vi.fn(),
    isLaunching: false,
    error: null,
    message: null,
    isConnected: false,
    platformAuth: undefined,
    isLoadingPlatformAuth: false,
  }
}

describe('PlatformTab profile section', () => {
  beforeEach(() => {
    platformConnectMock.mockReturnValue(disconnected())
  })

  it('leads with the profile section in auth mode, above the Gamut account block', () => {
    useUserMock.mockReturnValue(authUser)
    platformConnectMock.mockReturnValue({
      ...disconnected(),
      isConnected: true,
      platformAuth: { connected: true, platformControlled: false, orgName: 'Example workspace' },
    })
    render(<PlatformTab readOnly />)
    const section = screen.getByTestId('profile-section')
    expect(section.parentElement?.firstElementChild).toBe(section)
    expect(screen.getByText('Gamut Account')).toBeInTheDocument()
    expect(screen.getByText('Example workspace')).toBeInTheDocument()
    expect(screen.getByText(/Platform access is managed by this deployment/)).toBeInTheDocument()
  })

  it.each([false, true])('shows only the profile when disconnected in auth mode (admin: %s)', (isAdmin) => {
    useUserMock.mockReturnValue({ ...authUser, isAdmin })
    render(<PlatformTab readOnly />)
    expect(screen.getByTestId('profile-section')).toBeInTheDocument()
    expect(screen.queryByText('Gamut Account')).not.toBeInTheDocument()
    expect(screen.queryByText('No Gamut account connected to this workspace')).not.toBeInTheDocument()
    expect(screen.queryByText(/Platform access is managed by this deployment/)).not.toBeInTheDocument()
  })

  it('omits the profile section in local mode, where there is no user to edit', () => {
    useUserMock.mockReturnValue(localUser)
    render(<PlatformTab />)
    expect(screen.queryByTestId('profile-section')).not.toBeInTheDocument()
    expect(screen.getByText('Gamut Account')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect Account' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add access key' })).toBeInTheDocument()
  })

  it('keeps the profile section visible while platform status is still loading', () => {
    useUserMock.mockReturnValue(authUser)
    platformConnectMock.mockReturnValue({ ...disconnected(), isLoadingPlatformAuth: true })
    render(<PlatformTab readOnly />)
    expect(screen.getByTestId('profile-section')).toBeInTheDocument()
    expect(screen.getByText('Loading platform status…')).toBeInTheDocument()
  })
})

describe('PlatformTab billing card', () => {
  const connected = () => ({
    ...disconnected(),
    isConnected: true,
    platformAuth: { connected: true, platformControlled: false, orgName: 'Example workspace', orgId: 'org_1', platformBaseUrl: 'https://platform.example.com' },
  })
  const snapshot = (creditScope?: 'seat' | 'org') => ({
    connected: true,
    billing: {
      configured: true,
      subscription: { status: 'active', paymentStatus: 'current', currentPeriodEnd: '2026-10-27T16:00:00Z', creditScope: creditScope ?? 'seat' },
      seat: { balanceCents: 15000, startingBalanceCents: 40000 },
      orgPool: { poolBalanceCents: 500 },
    },
  })

  beforeEach(() => {
    useUserMock.mockReturnValue(localUser)
    platformConnectMock.mockReturnValue(connected())
  })

  afterEach(() => {
    billingInfoMock.mockReset()
    billingInfoMock.mockReturnValue({ data: undefined, isLoading: false, isFetching: false, error: null, refetch: vi.fn() })
  })

  it('shows a per-seat org exactly as before', () => {
    billingInfoMock.mockReturnValue({ data: snapshot('seat'), isLoading: false, isFetching: false, error: null, refetch: vi.fn() })
    render(<PlatformTab />)
    const row = screen.getByTestId('subscription-credits-row')
    expect(row).toHaveAttribute('data-scope', 'seat')
    expect(row).toHaveTextContent('Seat credits')
    expect(row).toHaveTextContent('38% remaining')
    expect(row).toHaveTextContent('$150.00 of $400.00')
    expect(row).not.toHaveTextContent(/shared|resets/)
    expect(screen.getByText('Shared pool used after your seat quota')).toBeInTheDocument()
    expect(screen.queryByText(/Team plan/)).not.toBeInTheDocument()
  })

  it('calls a pooled org\'s bar the shared team plan credit and says when it resets', () => {
    billingInfoMock.mockReturnValue({ data: snapshot('org'), isLoading: false, isFetching: false, error: null, refetch: vi.fn() })
    render(<PlatformTab />)
    const row = screen.getByTestId('subscription-credits-row')
    expect(row).toHaveAttribute('data-scope', 'org')
    expect(row).toHaveTextContent('Team plan credits')
    expect(row).toHaveTextContent('38% remaining')
    expect(row).toHaveTextContent(/\$150\.00 of \$400\.00 · shared by your whole organization, resets Oct 2[78]/)
    expect(row).not.toHaveTextContent('Seat credits')
    expect(screen.getByText('Shared pool used after your team plan credits')).toBeInTheDocument()
  })

  it('names the unsubscribed row by scope too', () => {
    const data = snapshot('org')
    billingInfoMock.mockReturnValue({ data: { ...data, billing: { ...data.billing, seat: null } }, isLoading: false, isFetching: false, error: null, refetch: vi.fn() })
    render(<PlatformTab />)
    expect(screen.getByText('Team plan credits')).toBeInTheDocument()
    expect(screen.getByText('Not subscribed')).toBeInTheDocument()
  })
})

describe('PlatformTab after connect', () => {
  it('shows the green Connected line and mounts the stale-agents notice beneath it', () => {
    useUserMock.mockReturnValue(localUser)
    platformConnectMock.mockReturnValue({
      ...disconnected(),
      isConnected: true,
      message: 'Connected.',
      platformAuth: { connected: true, platformControlled: false, orgName: 'Example workspace' },
    })
    render(<PlatformTab />)
    expect(screen.getByText('Connected.')).toBeInTheDocument()
    expect(screen.getByTestId('stale-agents-notice')).toBeInTheDocument()
  })
})

describe('PlatformTab plan (SUP-1143)', () => {
  const connected = (role: string | null = 'owner') => ({
    ...disconnected(),
    isConnected: true,
    platformAuth: { connected: true, platformControlled: false, orgName: 'Example workspace', orgId: 'org_1', role, platformBaseUrl: 'https://platform.example.com' },
  })
  const snapshot = (extra: Record<string, unknown>) => ({
    data: {
      connected: true,
      billing: {
        configured: true,
        subscription: { status: 'active', paymentStatus: 'current', currentPeriodEnd: '2026-10-27T16:00:00Z', creditScope: 'seat' },
        seat: { balanceCents: 15000, startingBalanceCents: 40000 },
        orgPool: { poolBalanceCents: 500 },
        plan: null,
        pendingPlanChange: null,
        ...extra,
      },
    },
    isLoading: false, isFetching: false, error: null, refetch: vi.fn(),
  })

  beforeEach(() => {
    useUserMock.mockReturnValue(localUser)
    platformConnectMock.mockReturnValue(connected())
    openPlanUpgradeMock.mockReset()
  })

  afterEach(() => {
    billingInfoMock.mockReset()
    billingInfoMock.mockReturnValue({ data: undefined, isLoading: false, isFetching: false, error: null, refetch: vi.fn() })
  })

  it('names a Pro 30 workspace\'s plan and the models it excludes, beside the workspace too', async () => {
    billingInfoMock.mockReturnValue(snapshot({ plan: { id: 'pro-30', name: 'Pro 30', deniedModels: ['claude-fable-', 'gpt-6-astra'] } }))
    render(<PlatformTab />)
    expect(screen.getByTestId('billing-plan-name')).toHaveTextContent('Pro 30')
    expect(screen.getByTestId('billing-plan-excludes')).toHaveTextContent('Excludes Claude Fable and GPT Astra')
    expect(screen.getByTestId('workspace-plan-badge')).toHaveTextContent('Pro 30')
    await userEvent.setup().click(screen.getByTestId('billing-change-plan'))
    expect(openPlanUpgradeMock).toHaveBeenCalledWith()
  })

  it('shows a scheduled downgrade with its date', () => {
    billingInfoMock.mockReturnValue(snapshot({
      plan: { id: 'pro-200', name: 'Pro 200', deniedModels: [] },
      pendingPlanChange: { toPlan: { id: 'pro-30', name: 'Pro 30' }, effectiveAt: '2026-11-13T12:00:00Z' },
    }))
    render(<PlatformTab />)
    expect(screen.getByTestId('billing-plan-name')).toHaveTextContent('Pro 200')
    expect(screen.queryByTestId('billing-plan-excludes')).not.toBeInTheDocument()
    expect(screen.getByTestId('billing-plan-pending')).toHaveTextContent(/^Switching to Pro 30 on Nov 13$/)
  })

  it('keeps the subscription state on the plan\'s name when it is not plainly active', () => {
    billingInfoMock.mockReturnValue(snapshot({
      subscription: { status: 'cancellation_scheduled', paymentStatus: 'current', currentPeriodEnd: null, creditScope: 'seat' },
      plan: { id: 'pro-100', name: 'Pro 100', deniedModels: [] },
    }))
    render(<PlatformTab />)
    expect(screen.getByTestId('billing-plan-name')).toHaveTextContent('Pro 100 · Cancelling')
  })

  it('offers Change plan only to owners and admins', () => {
    platformConnectMock.mockReturnValue(connected('member'))
    billingInfoMock.mockReturnValue(snapshot({ plan: { id: 'pro-30', name: 'Pro 30', deniedModels: ['claude-fable-'] } }))
    render(<PlatformTab />)
    expect(screen.getByTestId('billing-plan-name')).toHaveTextContent('Pro 30')
    expect(screen.queryByTestId('billing-change-plan')).not.toBeInTheDocument()
  })

  it('keeps the plain subscription row for an unsubscribed workspace', () => {
    billingInfoMock.mockReturnValue(snapshot({ subscription: { status: 'none', paymentStatus: null, currentPeriodEnd: null, creditScope: 'seat' } }))
    render(<PlatformTab />)
    expect(screen.queryByTestId('billing-plan-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-plan-badge')).not.toBeInTheDocument()
    expect(screen.getByText('Subscription')).toBeInTheDocument()
  })
})
