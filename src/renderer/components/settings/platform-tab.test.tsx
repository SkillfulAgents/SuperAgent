// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const platformConnectMock = vi.fn()
const billingInfoMock = vi.fn()

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformConnect: () => platformConnectMock(),
  useSavePlatformAccessKey: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}))

vi.mock('@renderer/hooks/use-billing-info', () => ({
  useBillingInfo: () => billingInfoMock(),
}))

vi.mock('@renderer/hooks/use-cloud-workspace', () => ({
  useCloudWorkspace: () => ({ data: null, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }),
}))

vi.mock('@renderer/lib/env', () => ({
  isElectron: () => false,
}))

vi.mock('@renderer/lib/open-external', () => ({
  openExternalUrl: vi.fn(),
}))

import { PlatformTab } from './platform-tab'

function connectedAuth(role: string | null) {
  return {
    handleConnect: vi.fn(),
    isLaunching: false,
    error: null,
    message: null,
    isConnected: true,
    platformAuth: {
      connected: true,
      email: 'a@example.com',
      orgId: 'org_1',
      orgName: 'Acme',
      role,
      updatedAt: null,
      platformBaseUrl: 'https://platform.example.com',
    },
    isLoadingPlatformAuth: false,
  }
}

const configuredBilling = {
  billing: {
    configured: true,
    subscription: { status: 'active', paymentStatus: 'ok' },
    seat: null,
    orgPool: { poolBalanceCents: 0 },
  },
}

const unconfiguredBilling = {
  billing: { configured: false },
}

describe('PlatformTab billing role gate', () => {
  beforeEach(() => {
    billingInfoMock.mockReturnValue({
      data: configuredBilling,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    })
  })

  it('shows Manage billing for owners', () => {
    platformConnectMock.mockReturnValue(connectedAuth('owner'))
    render(<PlatformTab />)
    expect(screen.getByRole('button', { name: /Manage/ })).toBeInTheDocument()
  })

  it('shows Manage billing for admins', () => {
    platformConnectMock.mockReturnValue(connectedAuth('admin'))
    render(<PlatformTab />)
    expect(screen.getByRole('button', { name: /Manage/ })).toBeInTheDocument()
  })

  it('shows Manage billing when the role is unknown (platform enforces access)', () => {
    platformConnectMock.mockReturnValue(connectedAuth(null))
    render(<PlatformTab />)
    expect(screen.getByRole('button', { name: /Manage/ })).toBeInTheDocument()
  })

  it('hides Manage billing for members', () => {
    platformConnectMock.mockReturnValue(connectedAuth('member'))
    render(<PlatformTab />)
    expect(screen.queryByText('Manage billing on the web')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Manage/ })).not.toBeInTheDocument()
  })

  it('hides Set up for members when billing is unconfigured', () => {
    billingInfoMock.mockReturnValue({
      data: unconfiguredBilling,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    })
    platformConnectMock.mockReturnValue(connectedAuth('member'))
    render(<PlatformTab />)
    expect(screen.queryByRole('button', { name: 'Set up' })).not.toBeInTheDocument()
    expect(screen.getByText('Managed by workspace admins')).toBeInTheDocument()
  })

  it('shows Set up for owners when billing is unconfigured', () => {
    billingInfoMock.mockReturnValue({
      data: unconfiguredBilling,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    })
    platformConnectMock.mockReturnValue(connectedAuth('owner'))
    render(<PlatformTab />)
    expect(screen.getByRole('button', { name: 'Set up' })).toBeInTheDocument()
  })
})
