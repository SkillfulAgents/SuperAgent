// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
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

function response(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(body) }
}

function appleReady(suggestions: Array<Record<string, string>> = []) {
  return {
    provider: 'apple-passwords',
    providerLabel: 'Apple Passwords',
    status: 'ready' as const,
    installable: true,
    searchable: false,
    origin: 'https://example.com',
    suggestions,
  }
}

function onePasswordPayload(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'onepassword',
    providerLabel: '1Password',
    status: 'ready' as const,
    installable: true,
    searchable: true,
    origin: 'https://x.com',
    suggestions: [],
    ...overrides,
  }
}

describe('BrowserCredentialPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApiFetch.mockReset()
    mockUser.isAuthMode = false
    mockUser.isAdmin = false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows metadata and sends only the opaque id on fill', async () => {
    const user = userEvent.setup()
    mockApiFetch
      .mockResolvedValueOnce(response(appleReady([{
        id: 'opaque-1',
        username: 'person@example.com',
        domain: 'example.com',
        title: 'Example',
      }])))
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
      .mockResolvedValueOnce(response(appleReady([{
        id: 'opaque-1',
        username: 'person@example.com',
        domain: 'example.com',
      }])))
      .mockResolvedValueOnce(response({
        error: 'No visible password field was found',
        reason: 'no_password_field',
        manualCredential: {
          username: 'person@example.com',
          password: 'host-only-secret',
        },
      }, false))
      .mockResolvedValueOnce(response(appleReady([{
        id: 'opaque-2',
        username: 'person@example.com',
        domain: 'example.com',
      }])))

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
      .mockResolvedValueOnce(response(appleReady([{
        id: 'opaque-1',
        username: 'person@example.com',
        domain: 'example.com',
      }])))
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
      searchable: false,
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
      searchable: false,
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
        searchable: false,
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
      .mockResolvedValueOnce(response(appleReady([{
        id: 'opaque-after-check',
        username: 'checked@example.com',
        domain: 'example.com',
      }])))

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

  it('renders the warming state and polls every 5s without refresh until ready', async () => {
    vi.useFakeTimers()
    mockApiFetch
      .mockResolvedValueOnce(response(onePasswordPayload({
        status: 'warming',
        suggestions: [],
      })))
      .mockResolvedValueOnce(response(onePasswordPayload({
        status: 'warming',
        suggestions: [],
      })))
      .mockResolvedValueOnce(response(onePasswordPayload({
        suggestions: [{
          id: 'opaque-1',
          username: 'person@example.com',
          domain: 'example.com',
        }],
      })))

    render(<BrowserCredentialPicker {...props} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByTestId('credential-picker-warming')).toBeInTheDocument()
    expect(screen.getByText('Loading your saved logins.')).toBeInTheDocument()
    expect(screen.queryByTestId('credential-picker-loading')).not.toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(mockApiFetch).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('credential-picker-warming')).toBeInTheDocument()
    expect(screen.queryByTestId('credential-picker-loading')).not.toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByText('person@example.com')).toBeInTheDocument()
    expect(mockApiFetch).toHaveBeenCalledTimes(3)
    for (const [url] of mockApiFetch.mock.calls) {
      expect(String(url)).not.toContain('refresh=true')
    }
  })

  it('stops polling when the request is gone (404)', async () => {
    vi.useFakeTimers()
    mockApiFetch
      .mockResolvedValueOnce(response(onePasswordPayload({ status: 'warming' })))
      .mockResolvedValueOnce(response({ error: 'Request not found' }, false, 404))

    render(<BrowserCredentialPicker {...props} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByTestId('credential-picker-warming')).toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(mockApiFetch).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('credential-picker-warming')).not.toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(mockApiFetch).toHaveBeenCalledTimes(2)
  })

  it('searches the page name when no site matches', async () => {
    vi.useFakeTimers()
    mockApiFetch
      .mockResolvedValueOnce(response(onePasswordPayload({ origin: 'https://github.com' })))
      .mockResolvedValueOnce(response(onePasswordPayload({
        origin: 'https://github.com',
        suggestions: [{ id: 'gh-1', title: 'GitHub' }],
      })))

    render(<BrowserCredentialPicker {...props} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByLabelText('Search your 1Password logins')).toHaveValue('github')
    expect(mockApiFetch).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(mockApiFetch.mock.calls[1][0]).toContain('q=github')
    expect(screen.getByText('GitHub')).toBeInTheDocument()
  })

  it('renders the search box instead of nothing for a searchable provider with zero matches', async () => {
    mockApiFetch.mockResolvedValueOnce(response(onePasswordPayload()))

    render(<BrowserCredentialPicker {...props} />)
    expect(await screen.findByPlaceholderText('Search your 1Password logins…')).toBeInTheDocument()
    expect(screen.getByText('No saved logins matched this page. Search your vault by name.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Switch password manager' })).not.toBeInTheDocument()
  })

  it('keeps null-render for a non-searchable provider with zero matches', async () => {
    mockApiFetch.mockResolvedValueOnce(response(appleReady()))

    render(<BrowserCredentialPicker {...props} />)
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce())
    expect(screen.queryByTestId('credential-picker')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Search your 1Password logins…')).not.toBeInTheDocument()
  })

  it('shows the search link under suggestions when searchable', async () => {
    mockApiFetch.mockResolvedValueOnce(response(onePasswordPayload({
      suggestions: [{
        id: 'opaque-1',
        username: 'person@example.com',
        domain: 'example.com',
      }],
    })))

    render(<BrowserCredentialPicker {...props} />)
    expect(await screen.findByRole('button', { name: 'Search 1Password for a different login…' })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Search your 1Password logins…')).not.toBeInTheDocument()
  })

  it('debounced typing queries ?q= and renders title-first rows for username-less items', async () => {
    vi.useFakeTimers()
    mockApiFetch
      .mockResolvedValueOnce(response(onePasswordPayload()))
      .mockResolvedValueOnce(response(onePasswordPayload({
        suggestions: [{
          id: 'gh-1',
          title: 'GitHub work',
          domain: 'github.com',
        }],
      })))

    render(<BrowserCredentialPicker {...props} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    fireEvent.change(screen.getByPlaceholderText('Search your 1Password logins…'), {
      target: { value: 'github' },
    })
    expect(mockApiFetch).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(mockApiFetch.mock.calls[1][0]).toBe(
      '/api/agents/agent%20a/sessions/session%2F1/browser-credentials' +
        '?toolUseId=tool%3F1&q=github',
    )
    expect(screen.getByText('GitHub work')).toBeInTheDocument()
    expect(screen.getByText('github.com')).toBeInTheDocument()
    expect(screen.queryByText('GitHub work · github.com')).not.toBeInTheDocument()
  })

  it('shows Switch password manager only in the search-found-nothing state', async () => {
    vi.useFakeTimers()
    mockApiFetch
      .mockResolvedValueOnce(response(onePasswordPayload()))
      .mockResolvedValueOnce(response(onePasswordPayload()))

    render(<BrowserCredentialPicker {...props} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByRole('button', { name: 'Switch password manager' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search your 1Password logins…'), {
      target: { value: 'obs' },
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    fireEvent.click(screen.getByRole('button', { name: 'Switch password manager' }))
    expect(mockOpenSettings).toHaveBeenCalledWith('browser')
  })

  it('re-issues the active query after a refetch', async () => {
    vi.useFakeTimers()
    mockApiFetch
      .mockResolvedValueOnce(response(onePasswordPayload({
        suggestions: [{ id: 'opaque-1', username: 'person@example.com', domain: 'example.com' }],
      })))
      .mockResolvedValueOnce(response(onePasswordPayload({
        suggestions: [{ id: 'gh-1', title: 'GitHub work', domain: 'github.com' }],
      })))
      .mockResolvedValueOnce(response({ error: 'Credential autofill failed' }, false))
      .mockResolvedValueOnce(response(onePasswordPayload({
        suggestions: [{ id: 'gh-2', title: 'GitHub work', domain: 'github.com' }],
      })))

    render(<BrowserCredentialPicker {...props} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    fireEvent.click(screen.getByRole('button', { name: 'Search 1Password for a different login…' }))
    fireEvent.change(screen.getByPlaceholderText('Search your 1Password logins…'), {
      target: { value: 'github' },
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    fireEvent.click(screen.getByTestId('credential-suggestion-gh-1'))
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(mockApiFetch.mock.calls.at(-1)?.[0]).toBe(
      '/api/agents/agent%20a/sessions/session%2F1/browser-credentials' +
        '?toolUseId=tool%3F1&refresh=true&q=github',
    )
  })

  it('renders subtext without dangling separators when domain is absent', async () => {
    mockApiFetch.mockResolvedValueOnce(response(onePasswordPayload({
      suggestions: [{
        id: 'bot-1',
        username: 'ci-bot',
        title: 'CI bot',
      }],
    })))

    render(<BrowserCredentialPicker {...props} />)
    expect(await screen.findByText('ci-bot')).toBeInTheDocument()
    expect(screen.getByText('CI bot')).toBeInTheDocument()
    expect(screen.queryByText(/ · /)).not.toBeInTheDocument()
  })

  it('parses responses through the shared schema and surfaces a parse failure as the error state', async () => {
    mockApiFetch.mockResolvedValueOnce(response({
      provider: 'onepassword',
      status: 'ready',
    }))

    render(<BrowserCredentialPicker {...props} />)
    expect(await screen.findByText('Could not load saved credentials')).toBeInTheDocument()
    expect(screen.queryByTestId('credential-picker')).not.toBeInTheDocument()
  })
})
