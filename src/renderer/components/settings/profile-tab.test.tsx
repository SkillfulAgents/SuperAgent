// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const publicAuthConfigMock = vi.fn()
const platformAuthMock = vi.fn()

vi.mock('@renderer/hooks/use-public-auth-config', () => ({
  usePublicAuthConfig: () => publicAuthConfigMock(),
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => platformAuthMock(),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    user: { id: 'u1', email: 'a@example.com', name: 'Ada' },
  }),
}))

vi.mock('@renderer/lib/auth-client', () => ({
  authClient: {
    updateUser: vi.fn(),
    changePassword: vi.fn(),
  },
}))

vi.mock('@renderer/lib/password-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/password-utils')>()
  return actual
})

import { ProfileTab } from './profile-tab'

describe('ProfileTab', () => {
  beforeEach(() => {
    publicAuthConfigMock.mockReturnValue({
      config: { allowLocalAuth: true },
      isLoading: false,
    })
    platformAuthMock.mockReturnValue({ data: { platformControlled: false } })
  })

  it('hides Change Password when platform-controlled', () => {
    platformAuthMock.mockReturnValue({ data: { platformControlled: true } })
    render(<ProfileTab />)
    expect(screen.queryByRole('button', { name: 'Change Password' })).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('a@example.com')).toBeInTheDocument()
  })

  it('hides Change Password when local auth is off', () => {
    publicAuthConfigMock.mockReturnValue({
      config: { allowLocalAuth: false },
      isLoading: false,
    })
    render(<ProfileTab />)
    expect(screen.queryByRole('button', { name: 'Change Password' })).not.toBeInTheDocument()
  })

  it('hides Change Password while auth-config is loading', () => {
    publicAuthConfigMock.mockReturnValue({
      config: { allowLocalAuth: true },
      isLoading: true,
    })
    render(<ProfileTab />)
    expect(screen.queryByRole('button', { name: 'Change Password' })).not.toBeInTheDocument()
  })

  it('shows Change Password for self-hosted local auth', () => {
    render(<ProfileTab />)
    expect(screen.getByRole('button', { name: 'Change Password' })).toBeInTheDocument()
  })
})
