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

  it('configures a provider with a square checkbox card without pairing it', async () => {
    const user = userEvent.setup()
    mockApiFetch
      .mockResolvedValueOnce(response({
        providers: [{
          provider: 'apple-passwords',
          providerLabel: 'Apple Passwords',
          configured: false,
          status: 'disconnected',
        }],
      }))
      .mockResolvedValueOnce(response({
        success: true,
        provider: 'apple-passwords',
        configured: true,
      }))

    render(<PasswordManagersSettings />)
    const option = await screen.findByRole('checkbox', { name: /Apple Passwords/i })
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
    expect(mockApiFetch).toHaveBeenCalledTimes(2)
  })

  it('shows prerequisite instructions and opens the extension directly in Chrome', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce(response({
      providers: [{
        provider: 'apple-passwords',
        providerLabel: 'Apple Passwords',
        configured: false,
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
    expect(screen.getByRole('checkbox', { name: /Apple Passwords/i })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Install in Chrome' }))
    expect(mockOpenApplePasswordsExtension).toHaveBeenCalledOnce()
  })
})
