// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const useUserMock = vi.fn()
const platformConnectMock = vi.fn()

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => useUserMock(),
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformConnect: () => platformConnectMock(),
  useSavePlatformAccessKey: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}))

vi.mock('@renderer/hooks/use-billing-info', () => ({
  useBillingInfo: () => ({ data: undefined, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }),
}))

vi.mock('@renderer/hooks/use-cloud-workspace', () => ({
  useCloudWorkspace: () => ({ data: undefined, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }),
}))

vi.mock('./profile-section', () => ({
  ProfileSection: () => <div data-testid="profile-section" />,
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
    render(<PlatformTab readOnly />)
    const section = screen.getByTestId('profile-section')
    expect(section.parentElement?.firstElementChild).toBe(section)
    expect(screen.getByText('Gamut Account')).toBeInTheDocument()
    expect(screen.getByText('No Gamut account connected to this workspace')).toBeInTheDocument()
  })

  it('omits the profile section in local mode, where there is no user to edit', () => {
    useUserMock.mockReturnValue(localUser)
    render(<PlatformTab />)
    expect(screen.queryByTestId('profile-section')).not.toBeInTheDocument()
    expect(screen.getByText('Gamut Account')).toBeInTheDocument()
  })

  it('keeps the profile section visible while platform status is still loading', () => {
    useUserMock.mockReturnValue(authUser)
    platformConnectMock.mockReturnValue({ ...disconnected(), isLoadingPlatformAuth: true })
    render(<PlatformTab readOnly />)
    expect(screen.getByTestId('profile-section')).toBeInTheDocument()
    expect(screen.getByText('Loading platform status…')).toBeInTheDocument()
  })
})
