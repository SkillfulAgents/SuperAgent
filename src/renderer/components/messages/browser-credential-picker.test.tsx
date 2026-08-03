// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import { BrowserCredentialPicker } from './browser-credential-picker'

const mockApiFetch = vi.hoisted(() => vi.fn())
const mockOpenSettings = vi.hoisted(() => vi.fn())
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

const props = {
  agentSlug: 'agent a',
  sessionId: 'session/1',
  toolUseId: 'tool?1',
}

function response(body: unknown, ok = true) {
  return { ok, json: () => Promise.resolve(body) }
}

describe('BrowserCredentialPicker', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows metadata and sends only the opaque id on fill', async () => {
    const user = userEvent.setup()
    mockApiFetch
      .mockResolvedValueOnce(response({
        provider: 'apple-passwords',
        providerLabel: 'Apple Passwords',
        status: 'ready',
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

  it('links to Browser Use settings when no password manager is configured', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce(response({
      provider: 'none',
      providerLabel: 'Password manager',
      status: 'unconfigured',
      origin: 'https://example.com',
      suggestions: [],
    }))
    render(<BrowserCredentialPicker {...props} />)
    await user.click(await screen.findByRole('button', { name: 'Connect Password Manager' }))
    expect(mockOpenSettings).toHaveBeenCalledWith('browser')
  })

  it('checks and verifies a configured provider before showing credentials', async () => {
    const user = userEvent.setup()
    mockApiFetch
      .mockResolvedValueOnce(response({
        provider: 'apple-passwords',
        providerLabel: 'Apple Passwords',
        status: 'locked',
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
  })
})
