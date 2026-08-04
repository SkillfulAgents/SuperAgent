// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const useSettingsMock = vi.fn()

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => useSettingsMock(),
  useUpdateSettings: () => ({ mutate: vi.fn() }),
}))

import { AuthTab } from './auth-tab'

describe('AuthTab', () => {
  beforeEach(() => {
    useSettingsMock.mockReturnValue({
      isLoading: false,
      data: {
        auth: {
          signupMode: 'invitation_only',
          requireAdminApproval: true,
          allowLocalAuth: true,
          allowSocialAuth: false,
          passwordMinLength: 12,
          trustedOrigins: [],
        },
      },
    })
  })

  it('hides Signup & Access, Authentication Methods, and Password Policy when platform-controlled', () => {
    render(<AuthTab hideLocalAuthSections />)
    expect(screen.queryByText('Signup & Access')).not.toBeInTheDocument()
    expect(screen.queryByText('Authentication Methods')).not.toBeInTheDocument()
    expect(screen.queryByText('Password Policy')).not.toBeInTheDocument()
    expect(screen.getByText('Session & Lockout')).toBeInTheDocument()
    expect(screen.getByText('Trusted Origins')).toBeInTheDocument()
  })

  it('shows local auth sections by default', () => {
    render(<AuthTab />)
    expect(screen.getByText('Signup & Access')).toBeInTheDocument()
    expect(screen.getByText('Authentication Methods')).toBeInTheDocument()
    expect(screen.getByText('Password Policy')).toBeInTheDocument()
  })
})
