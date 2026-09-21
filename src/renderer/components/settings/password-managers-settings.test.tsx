// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import { PasswordManagersSettings } from './password-managers-settings'

const mockApiFetch = vi.fn()
const mockOpenApplePasswordsExtension = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

function response(body: unknown, ok = true) {
  return { ok, json: () => Promise.resolve(body) }
}

describe('PasswordManagersSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ...window.electronAPI,
        openApplePasswordsExtension: mockOpenApplePasswordsExtension,
      },
    })
  })

  it('configures a provider with a radio card without pairing it', async () => {
    const user = userEvent.setup()
    mockApiFetch
      .mockResolvedValueOnce(response({
        providers: [{
          provider: 'apple-passwords',
          providerLabel: 'Apple Passwords',
          configured: false,
          installable: true,
          status: 'disconnected',
        }],
      }))
      .mockResolvedValueOnce(response({
        success: true,
        provider: 'apple-passwords',
        configured: true,
      }))
      .mockResolvedValueOnce(response({
        providers: [{
          provider: 'apple-passwords',
          providerLabel: 'Apple Passwords',
          configured: true,
          installable: true,
          status: 'disconnected',
        }],
      }))

    render(<PasswordManagersSettings />)
    const option = await screen.findByRole('radio', { name: /Apple Passwords/i })
    expect(screen.getByText('Experimental')).toBeInTheDocument()
    expect(option).toHaveAttribute('aria-checked', 'false')
    await user.click(option)

    expect(option).toHaveAttribute('aria-checked', 'true')
    expect(mockApiFetch.mock.calls[0][0]).toBe('/api/settings/password-managers')
    expect(mockApiFetch.mock.calls[1][0]).toBe(
      '/api/settings/password-managers/apple-passwords',
    )
    expect(mockApiFetch.mock.calls[1][1].method).toBe('PUT')
    expect(JSON.parse(mockApiFetch.mock.calls[1][1].body)).toEqual({ configured: true })
    expect(mockApiFetch.mock.calls[2][0]).toBe('/api/settings/password-managers')
    expect(mockApiFetch).toHaveBeenCalledTimes(3)
  })

  it('shows prerequisite instructions and opens the extension directly in Chrome', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce(response({
      providers: [{
        provider: 'apple-passwords',
        providerLabel: 'Apple Passwords',
        configured: false,
        installable: true,
        status: 'unavailable',
        message: 'Install the iCloud Passwords extension in Chrome',
        remediation: {
          code: 'extension_not_found',
          title: 'Install the iCloud Passwords extension',
          instructions: [
            'Open the extension in Chrome and choose Add to Chrome.',
            'Return here and refresh.',
          ],
          action: {
            kind: 'open_in_chrome',
            label: 'Install in Chrome',
            url: 'https://chromewebstore.google.com/example',
          },
        },
      }],
    }))

    render(<PasswordManagersSettings />)
    expect(await screen.findByText('Install the iCloud Passwords extension in Chrome')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Apple Passwords/i })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Install in Chrome' }))
    expect(mockOpenApplePasswordsExtension).toHaveBeenCalledOnce()
  })

  it('refetches after enabling one provider so the other card unchecks', async () => {
    const user = userEvent.setup()
    mockApiFetch
      .mockResolvedValueOnce(response({
        providers: [{
          provider: 'apple-passwords',
          providerLabel: 'Apple Passwords',
          configured: true,
          installable: true,
          status: 'disconnected',
        }, {
          provider: 'onepassword',
          providerLabel: '1Password',
          configured: false,
          installable: true,
          status: 'disconnected',
        }],
      }))
      .mockResolvedValueOnce(response({
        success: true,
        provider: 'onepassword',
        configured: true,
      }))
      .mockResolvedValueOnce(response({
        providers: [{
          provider: 'apple-passwords',
          providerLabel: 'Apple Passwords',
          configured: false,
          installable: true,
          status: 'disconnected',
        }, {
          provider: 'onepassword',
          providerLabel: '1Password',
          configured: true,
          installable: true,
          status: 'disconnected',
        }],
      }))

    render(<PasswordManagersSettings />)
    const apple = await screen.findByRole('radio', { name: /Apple Passwords/i })
    const one = screen.getByRole('radio', { name: /1Password/i })
    expect(apple).toHaveAttribute('aria-checked', 'true')
    expect(one).toHaveAttribute('aria-checked', 'false')
    await user.click(one)
    expect(one).toHaveAttribute('aria-checked', 'true')
    expect(apple).toHaveAttribute('aria-checked', 'false')
  })

  it('shows 1Password copy and combined remediation', async () => {
    mockApiFetch.mockResolvedValueOnce(response({
      providers: [{
        provider: 'onepassword',
        providerLabel: '1Password',
        configured: false,
        installable: true,
        status: 'disconnected',
      }, {
        provider: 'onepassword-missing',
        providerLabel: '1Password setup',
        configured: false,
        installable: true,
        status: 'unavailable',
        remediation: {
          code: 'onepassword_missing',
          title: 'Set up 1Password',
          instructions: [
            'Download and install the 1Password desktop app, then sign in.',
            'Install the 1Password command-line tool (op).',
            'In 1Password, turn on Settings → Developer → Integrate with 1Password CLI.',
            'Return here and refresh.',
          ],
        },
      }],
    }))

    render(<PasswordManagersSettings />)
    expect(await screen.findByText('Fill logins saved in 1Password during browser tasks.')).toBeInTheDocument()
    expect(screen.getByText('You’ll approve access in the 1Password app when needed.')).toBeInTheDocument()
    expect(screen.getByText('Set up 1Password')).toBeInTheDocument()
    expect(screen.getByText('Install the 1Password command-line tool (op).')).toBeInTheDocument()
  })
})
