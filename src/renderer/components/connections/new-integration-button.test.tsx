// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@renderer/test/test-utils'
import { NewIntegrationButton } from './connections-list'
import { OAUTH_ABORT_DELAY_MS } from '@renderer/hooks/use-delayed-oauth-abort'

const MOCK_ACCOUNT_ID = 'new-account-123'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const popupMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  close: vi.fn(),
}))

vi.mock('@renderer/lib/oauth-popup', () => ({
  prepareOAuthPopup: () => ({ navigate: popupMocks.navigate, close: popupMocks.close }),
}))

vi.mock('@shared/lib/account-providers', () => ({
  getProvider: (slug: string) => ({
    slug,
    displayName: slug.charAt(0).toUpperCase() + slug.slice(1),
  }),
}))

vi.mock('@renderer/hooks/use-mcp-oauth-listener', () => ({
  useMcpOAuthListener: vi.fn(),
}))

let capturedOAuthCallback: ((params: any) => void) | null = null
let originalElectronAPI: typeof window.electronAPI

function mockFetchResponses() {
  mockApiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/providers') {
      return {
        ok: true,
        json: async () => ({
          providers: [
            { slug: 'slack', displayName: 'Slack', description: 'Team communication' },
          ],
        }),
      }
    }
    if (url === '/api/connected-accounts/initiate') {
      return {
        ok: true,
        json: async () => ({
          connectionId: 'pending-conn-123',
          redirectUrl: 'https://oauth.example.test/authorize',
          providerSlug: 'slack',
        }),
      }
    }
    if (url === '/api/connected-accounts/complete') {
      return {
        ok: true,
        json: async () => ({
          success: true,
          account: { id: MOCK_ACCOUNT_ID, toolkitSlug: 'slack', displayName: 'Slack Account' },
        }),
      }
    }
    if (url.startsWith('/api/policies/scope/')) {
      return { ok: true, json: async () => ({ policies: [] }) }
    }
    return { ok: true, json: async () => ({}) }
  })
}

beforeEach(() => {
  originalElectronAPI = window.electronAPI
  vi.clearAllMocks()
  popupMocks.navigate.mockReset()
  popupMocks.close.mockReset()
  mockFetchResponses()
})

afterEach(() => {
  vi.useRealTimers()
  window.electronAPI = originalElectronAPI
  capturedOAuthCallback = null
})

describe('NewIntegrationButton — post-OAuth policy editor', () => {
  it('opens ScopePolicyEditor after Electron IPC OAuth callback', async () => {
    const unsubscribe = vi.fn()
    window.electronAPI = {
      // onOAuthCallback now returns a per-listener unsubscribe (SUP-215).
      onOAuthCallback: vi.fn((cb: any) => { capturedOAuthCallback = cb; return unsubscribe }),
      openExternal: vi.fn(),
    } as any

    renderWithProviders(<NewIntegrationButton />)

    await userEvent.click(screen.getByTestId('connections-add-button'))

    await waitFor(() => {
      expect(screen.getByText('Slack')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByTestId('directory-connect-api-slack'))

    expect(capturedOAuthCallback).not.toBeNull()

    // Simulate Electron OAuth callback with connectionId + toolkit
    await act(async () => {
      await capturedOAuthCallback!({
        connectionId: 'composio-conn-123',
        toolkit: 'slack',
        status: 'success',
      })
    })

    await waitFor(() => {
      expect(screen.getByText(/Successfully Connected/i)).toBeInTheDocument()
    }, { timeout: 3000 })
  })

  it('opens ScopePolicyEditor after web postMessage OAuth callback', async () => {
    window.electronAPI = undefined

    renderWithProviders(<NewIntegrationButton />)

    await userEvent.click(screen.getByTestId('connections-add-button'))

    await waitFor(() => {
      expect(screen.getByText('Slack')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByTestId('directory-connect-api-slack'))

    await act(async () => {
      window.postMessage(
        { type: 'oauth-callback', success: true, accountId: MOCK_ACCOUNT_ID, toolkitSlug: 'slack' },
        '*',
      )
      // Let the async message handler settle
      await new Promise((r) => setTimeout(r, 50))
    })

    await waitFor(() => {
      expect(screen.getByText(/Successfully Connected/i)).toBeInTheDocument()
    }, { timeout: 3000 })
  })

  it('falls back to closing dialog when accountId is missing', async () => {
    window.electronAPI = undefined

    renderWithProviders(<NewIntegrationButton />)

    await userEvent.click(screen.getByTestId('connections-add-button'))

    await waitFor(() => {
      expect(screen.getByText('Slack')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByTestId('directory-connect-api-slack'))

    await act(async () => {
      window.postMessage(
        { type: 'oauth-callback', success: true },
        '*',
      )
      await new Promise((r) => setTimeout(r, 50))
    })

    // Dialog closes but no policy editor
    await waitFor(() => {
      expect(screen.queryByText('Add New Connection')).not.toBeInTheDocument()
    })
    expect(screen.queryByText(/Successfully Connected/i)).not.toBeInTheDocument()
  })

  it('shows delayed cancel during Electron OAuth and removes the pending listener', async () => {
    const user = userEvent.setup()
    const unsubscribe = vi.fn()
    window.electronAPI = {
      onOAuthCallback: vi.fn((cb: any) => { capturedOAuthCallback = cb; return unsubscribe }),
      openExternal: vi.fn(),
    } as any

    renderWithProviders(<NewIntegrationButton />)

    await user.click(screen.getByTestId('connections-add-button'))

    await waitFor(() => {
      expect(screen.getByText('Slack')).toBeInTheDocument()
    })

    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(screen.getByTestId('directory-connect-api-slack'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(capturedOAuthCallback).not.toBeNull()
    expect(screen.queryByTestId('directory-cancel-api-slack')).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(OAUTH_ABORT_DELAY_MS)
    })

    expect(screen.getByTestId('directory-cancel-api-slack')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByTestId('directory-cancel-api-slack'))
      await Promise.resolve()
    })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(popupMocks.close).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('directory-connect-api-slack')).not.toBeDisabled()
  })
})
