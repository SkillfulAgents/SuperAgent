// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch,
  // redirect-stash helpers used by the email/OAuth sign-in handlers.
  consumeRedirectStash: () => null,
  peekRedirectStash: () => '/',
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

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows loading while fetching auth config', () => {
    apiFetch.mockReturnValue(new Promise(() => {}))

    render(<AuthPage />)

    expect(screen.getByTestId('auth-config-loading')).toHaveTextContent('Loading authentication options...')
  })

  it('surfaces auth config fetch errors without rendering fallback auth forms', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Auth config unavailable' }),
    })

    render(<AuthPage />)

    await waitFor(() => {
      expect(screen.getByTestId('auth-config-error')).toHaveTextContent('Auth config unavailable')
    })
    expect(screen.queryByTestId('signin-submit')).not.toBeInTheDocument()
    expect(screen.queryByTestId('auth-provider-platform')).not.toBeInTheDocument()
  })

  it('keeps loading through deployment_unavailable and never shows the error code', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'deployment_unavailable', state: 'waking' }),
    })

    render(<AuthPage />)

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/auth-config')
    })
    expect(screen.getByTestId('auth-config-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('auth-config-error')).not.toBeInTheDocument()
    expect(screen.queryByText('deployment_unavailable')).not.toBeInTheDocument()
  })

  it('retries auth config after deployment_unavailable and reloads once the origin answers', async () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })

    apiFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'deployment_unavailable', state: 'waking' }),
      })
      .mockResolvedValueOnce({
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

    render(<AuthPage />)

    await act(async () => {
      await Promise.resolve()
    })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByTestId('auth-config-loading')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledOnce()
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

    expect(screen.getByText('Gamut')).toBeInTheDocument()
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

  it('only shows provider loading state on the clicked provider', async () => {
    vi.mocked(signIn.oauth2).mockReturnValue(new Promise(() => {}) as never)
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
            displayName: 'Platform',
            icon: null,
            enabled: true,
            available: true,
            readiness: { ok: true, reasons: [] },
          },
          {
            id: 'other',
            type: 'oidc',
            displayName: 'Other',
            icon: null,
            enabled: true,
            available: true,
            readiness: { ok: true, reasons: [] },
          },
        ],
        passwordMinLength: 8,
        passwordRequireComplexity: false,
        requireAdminApproval: false,
        hasUsers: true,
      }),
    })

    render(<AuthPage />)

    await waitFor(() => {
      expect(screen.getByTestId('auth-provider-platform')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('auth-provider-platform'))

    expect(screen.getByTestId('auth-provider-platform')).toBeDisabled()
    expect(screen.getByTestId('auth-provider-other')).not.toBeDisabled()
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
    expect(screen.getByTestId('auth-provider-platform')).toBeDisabled()
    expect(screen.getByTestId('auth-provider-platform')).toHaveAttribute('title', 'Missing client ID')
  })

  it('renders OIDC-only first-user deployments without local signup', async () => {
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
            displayName: 'Platform',
            icon: null,
            enabled: true,
            available: true,
            readiness: { ok: true, reasons: [] },
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
    expect(screen.queryByTestId('auth-tab-signup')).not.toBeInTheDocument()
    expect(screen.queryByTestId('signup-submit')).not.toBeInTheDocument()
  })
})
