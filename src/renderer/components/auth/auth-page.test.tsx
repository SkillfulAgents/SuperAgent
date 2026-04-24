// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch,
}))

import { AuthPage } from './auth-page'
import { signIn } from '@renderer/lib/auth-client'

describe('AuthPage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(signIn.oauth2).mockResolvedValue(undefined as never)
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        signupMode: 'open',
        allowLocalAuth: true,
        allowSocialAuth: false,
        providers: [],
        passwordMinLength: 8,
        passwordRequireComplexity: false,
        requireAdminApproval: false,
        hasUsers: false,
      }),
    })
  })

  it('renders configured providers from auth config', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        signupMode: 'open',
        allowLocalAuth: true,
        allowSocialAuth: false,
        providers: [
          {
            id: 'platform',
            type: 'oidc',
            displayName: 'SSO',
            icon: null,
            enabled: true,
            available: true,
            readiness: {
              ok: true,
              reasons: [],
            },
          },
        ],
        passwordMinLength: 8,
        passwordRequireComplexity: false,
        requireAdminApproval: false,
        hasUsers: false,
      }),
    })

    render(<AuthPage />)

    await waitFor(() => {
      expect(screen.getByTestId('auth-provider-platform')).toBeInTheDocument()
    })

    expect(screen.getByText('SuperAgent')).toBeInTheDocument()
    expect(screen.getByText('Continue with SSO')).toBeInTheDocument()
    expect(screen.getByText('or')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('auth-provider-platform'))

    await waitFor(() => {
      expect(signIn.oauth2).toHaveBeenCalledWith({
        providerId: 'platform',
        callbackURL: '/',
        errorCallbackURL: '/',
      })
    })
  })

  it('hides local auth when deployment only exposes external providers', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        signupMode: 'open',
        allowLocalAuth: false,
        allowSocialAuth: false,
        providers: [
          {
            id: 'platform',
            type: 'oidc',
            displayName: 'SSO',
            icon: null,
            enabled: true,
            available: false,
            readiness: {
              ok: false,
              reasons: ['Missing client ID'],
            },
          },
        ],
        passwordMinLength: 8,
        passwordRequireComplexity: false,
        requireAdminApproval: false,
        hasUsers: false,
      }),
    })

    render(<AuthPage />)

    await waitFor(() => {
      expect(screen.getByTestId('auth-provider-platform')).toBeInTheDocument()
    })

    expect(screen.queryByTestId('auth-tab-signin')).not.toBeInTheDocument()
    expect(screen.queryByTestId('signin-submit')).not.toBeInTheDocument()
    expect(screen.queryByText('Missing client ID')).not.toBeInTheDocument()
  })
})
