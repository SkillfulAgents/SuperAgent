// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import { BrowserCredentialPicker } from './browser-credential-picker'

const mockApiFetch = vi.hoisted(() => vi.fn())
const mockOpenSettings = vi.hoisted(() => vi.fn())
const mockUser = vi.hoisted(() => ({ isAuthMode: false, isAdmin: false }))
vi.mock('@renderer/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/lib/api')>(),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))
vi.mock('@renderer/context/dialog-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/context/dialog-context')>(),
  useDialogs: () => ({
    openSettings: mockOpenSettings,
    closeSettings: vi.fn(),
    openWizard: vi.fn(),
  }),
}))
vi.mock('@renderer/context/user-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/context/user-context')>(),
  useUser: () => mockUser,
}))

const props = {
  agentSlug: 'agent a',
  sessionId: 'session/1',
  toolUseId: 'tool?1',
}

function response(body: unknown, ok = true) {
  return { ok, json: () => Promise.resolve(body) }
}

describe('BrowserCredentialPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUser.isAuthMode = false
    mockUser.isAdmin = false
  })

  it('shows metadata and sends only the opaque id on fill', async () => {
    const user = userEvent.setup()
    mockApiFetch
      .mockResolvedValueOnce(response({
        provider: 'apple-passwords',
        providerLabel: 'Apple Passwords',
        status: 'ready',
        installable: true,
        origin: 'https://example.com',
        suggestions: [{
          id: 'opaque-1',
          username: 'person@example.com',
          domain: 'example.com',
          title: 'Example',
        }],
      }))
      .mockResolvedValueOnce(response({ success: true, usernameFilled: true, passwordFilled: true }))

    render(<BrowserCredentialPicker {...props} />)
    expect(await screen.findByText('person@example.com')).toBeInTheDocument()
    expect(screen.getByText('Example · example.com')).toBeInTheDocument()

    await user.click(screen.getByTestId('credential-suggestion-opaque-1'))
    await waitFor(() => expect(screen.getByTestId('credential-picker-filled')).toBeInTheDocument())
    expect(screen.getByText('Continue signing in in the browser.')).toBeInTheDocument()
    expect(screen.queryByText(/click Done/i)).not.toBeInTheDocument()

    expect(mockApiFetch.mock.calls[0][0]).toBe(
      '/api/agents/agent%20a/sessions/session%2F1/browser-credentials?toolUseId=tool%3F1',
    )
    expect(mockApiFetch.mock.calls[1][0]).toBe(
      '/api/agents/agent%20a/sessions/session%2F1/autofill-browser-credential',
    )
    expect(JSON.parse(mockApiFetch.mock.calls[1][1].body)).toEqual({
      toolUseId: 'tool?1',
      credentialId: 'opaque-1',
    })
  })

  it('shows reveal and copy controls when the browser fields cannot be reached', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    mockApiFetch
      .mockResolvedValueOnce(response({
        provider: 'apple-passwords',
        providerLabel: 'Apple Passwords',
        status: 'ready',
        installable: true,
        origin: 'https://example.com',
        suggestions: [{
          id: 'opaque-1',
          username: 'person@example.com',
          domain: 'example.com',
        }],
      }))
      .mockResolvedValueOnce(response({
        error: 'No visible password field was found',
        reason: 'no_password_field',
        manualCredential: {
          username: 'person@example.com',
          password: 'host-only-secret',
        },
      }, false))
      .mockResolvedValueOnce(response({
        provider: 'apple-passwords',
        providerLabel: 'Apple Passwords',
        status: 'ready',
        installable: true,
        origin: 'https://example.com',
        suggestions: [{
          id: 'opaque-2',
          username: 'person@example.com',
          domain: 'example.com',
        }],
      }))

    render(<BrowserCredentialPicker {...props} />)
    await user.click(await screen.findByTestId('credential-suggestion-opaque-1'))

    expect(await screen.findByTestId('credential-picker-manual')).toBeInTheDocument()
    expect(screen.getByText('person@example.com')).toBeInTheDocument()
    expect(screen.queryByText('host-only-secret')).not.toBeInTheDocument()
    expect(screen.getByText('Password hidden')).toHaveClass('sr-only')

    await user.click(screen.getByRole('button', { name: 'Copy username' }))
    expect(writeText).toHaveBeenLastCalledWith('person@example.com')

    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(screen.getByText('host-only-secret')).toBeInTheDocument()
    expect(screen.getByText('host-only-secret')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('Password: host-only-secret')).toHaveClass('sr-only')
    await user.click(screen.getByRole('button', { name: 'Copy password' }))
    expect(writeText).toHaveBeenLastCalledWith('host-only-secret')

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('credential-suggestion-opaque-2')).toBeInTheDocument()
    expect(mockApiFetch.mock.calls[2][0]).toBe(
      '/api/agents/agent%20a/sessions/session%2F1/browser-credentials' +
        '?toolUseId=tool%3F1&refresh=true',
    )
  })

  it('clears the copied-state timer when the manual panel unmounts', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const clearTimeout = vi.spyOn(window, 'clearTimeout')
    mockApiFetch
      .mockResolvedValueOnce(response({
        provider: 'apple-passwords',
        providerLabel: 'Apple Passwords',
        status: 'ready',
        installable: true,
        origin: 'https://example.com',
        suggestions: [{ id: 'opaque-1', username: 'person@example.com', domain: 'example.com' }],
      }))
      .mockResolvedValueOnce(response({
        error: 'No visible password field was found',
        reason: 'no_password_field',
        manualCredential: { username: 'person@example.com', password: 'host-only-secret' },
      }, false))

    const view = render(<BrowserCredentialPicker {...props} />)
    await user.click(await screen.findByTestId('credential-suggestion-opaque-1'))
    await user.click(await screen.findByRole('button', { name: 'Copy password' }))
    const callsBeforeUnmount = clearTimeout.mock.calls.length

    view.unmount()

    expect(clearTimeout.mock.calls.length).toBeGreaterThan(callsBeforeUnmount)
    clearTimeout.mockRestore()
  })

  it('links to Browser Use settings when no password manager is configured', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce(response({
      provider: 'none',
      providerLabel: 'Password manager',
      status: 'unconfigured',
      installable: true,
      origin: 'https://example.com',
      suggestions: [],
    }))
    render(<BrowserCredentialPicker {...props} />)
    await user.click(await screen.findByRole('button', { name: 'Connect Password Manager' }))
    expect(mockOpenSettings).toHaveBeenCalledWith('browser')
  })

  it('suppresses the connect nudge when no provider is installable on this host', async () => {
    mockApiFetch.mockResolvedValueOnce(response({
      provider: 'none',
      providerLabel: 'Password manager',
      status: 'unconfigured',
      installable: false,
      origin: 'https://example.com',
      suggestions: [],
    }))

    render(<BrowserCredentialPicker {...props} />)
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button', { name: 'Connect Password Manager' })).not.toBeInTheDocument()
  })

  it('does not query host credentials for a non-admin in auth mode', async () => {
    mockUser.isAuthMode = true
    mockUser.isAdmin = false

    render(<BrowserCredentialPicker {...props} />)

    await waitFor(() => expect(screen.queryByTestId('credential-picker-loading')).not.toBeInTheDocument())
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('checks and verifies a configured provider before showing credentials', async () => {
    const user = userEvent.setup()
    mockApiFetch
      .mockResolvedValueOnce(response({
        provider: 'apple-passwords',
        providerLabel: 'Apple Passwords',
        status: 'locked',
        installable: true,
        origin: 'https://example.com',
        suggestions: [],
      }))
      .mockResolvedValueOnce(response({
        success: true,
        status: 'verification_required',
        verification: {
          type: 'numeric_code',
          length: 6,
          message: 'Enter the code shown by your password manager.',
        },
      }))
      .mockResolvedValueOnce(response({ success: true, status: 'connected' }))
      .mockResolvedValueOnce(response({
        provider: 'apple-passwords',
        providerLabel: 'Apple Passwords',
        status: 'ready',
        installable: true,
        origin: 'https://example.com',
        suggestions: [{
          id: 'opaque-after-check',
          username: 'checked@example.com',
          domain: 'example.com',
        }],
      }))

    render(<BrowserCredentialPicker {...props} />)
    await user.click(await screen.findByRole('button', { name: 'Check Password Manager' }))
    const code = await screen.findByLabelText('Apple Passwords verification code')
    await user.type(code, '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    expect(await screen.findByText('checked@example.com')).toBeInTheDocument()
    expect(mockApiFetch.mock.calls[1][0]).toBe(
      '/api/agents/agent%20a/sessions/session%2F1/browser-credentials/check',
    )
    expect(JSON.parse(mockApiFetch.mock.calls[1][1].body)).toEqual({
      toolUseId: 'tool?1',
      provider: 'apple-passwords',
    })
    expect(mockApiFetch.mock.calls[2][0]).toBe(
      '/api/agents/agent%20a/sessions/session%2F1/browser-credentials/verify',
    )
    expect(JSON.parse(mockApiFetch.mock.calls[2][1].body)).toEqual({
      toolUseId: 'tool?1',
      provider: 'apple-passwords',
      code: '123456',
    })
    expect(mockApiFetch.mock.calls[3][0]).toBe(
      '/api/agents/agent%20a/sessions/session%2F1/browser-credentials' +
        '?toolUseId=tool%3F1&refresh=true',
    )
  })
})
