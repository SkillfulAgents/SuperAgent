// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@renderer/test/test-utils'
import { NewIntegrationButton } from './connections-list'

const MOCK_ACCOUNT_ID = 'new-account-123'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

vi.mock('@renderer/lib/oauth-popup', () => ({
  prepareOAuthPopup: () => ({ navigate: vi.fn(), close: vi.fn() }),
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
  mockFetchResponses()
})

afterEach(() => {
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
})
