// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()

const useSettingsMock = vi.fn()
const mutateMock = vi.fn()
const platformAuthMock = vi.fn()

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => useSettingsMock(),
  useUpdateSettings: () => ({ mutate: mutateMock }),
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => platformAuthMock(),
}))

vi.mock('./provider-api-key-input', () => ({
  ProviderApiKeyInput: () => null,
}))

import { WebTab } from './web-tab'

function setup(options?: {
  webProvider?: string
  webProviderIsDefault?: boolean
  connected?: boolean
}) {
  useSettingsMock.mockReturnValue({
    isLoading: false,
    data: {
      webProvider: options?.webProvider ?? 'platform',
      webProviderIsDefault: options?.webProviderIsDefault ?? true,
    },
  })
  platformAuthMock.mockReturnValue({ data: { connected: options?.connected ?? false } })
}

describe('WebTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the active vendor marked "(default)" when isDefault', () => {
    setup({ webProvider: 'platform', webProviderIsDefault: true, connected: true })
    render(<WebTab />)

    expect(screen.getByRole('combobox')).toHaveTextContent('Platform')
    expect(screen.getByText('(default)')).toBeInTheDocument()
  })

  it('shows a pinned choice without the "(default)" marker', () => {
    setup({ webProvider: 'exa', webProviderIsDefault: false, connected: true })
    render(<WebTab />)

    expect(screen.getByRole('combobox')).toHaveTextContent('Exa')
    expect(screen.queryByText('(default)')).not.toBeInTheDocument()
  })

  it('offers only concrete vendors, Platform first', async () => {
    setup({ webProvider: 'platform', webProviderIsDefault: true, connected: true })
    const user = userEvent.setup()
    render(<WebTab />)

    await user.click(screen.getByRole('combobox'))
    await screen.findByRole('option', { name: /^Native$/i })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Platform',
      'Exa',
      'Native',
    ])
  })

  it('disables the Platform option when not signed into Gamut', async () => {
    setup({ webProvider: 'native', webProviderIsDefault: true, connected: false })
    const user = userEvent.setup()
    render(<WebTab />)

    await user.click(screen.getByRole('combobox'))
    const platformOption = await screen.findByRole('option', { name: /Platform/i })
    expect(platformOption).toHaveAttribute('aria-disabled', 'true')
  })

  it('pins the chosen vendor to the single webProvider field', async () => {
    setup({ webProvider: 'platform', webProviderIsDefault: true, connected: true })
    const user = userEvent.setup()
    render(<WebTab />)

    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: /^Native$/i }))

    expect(mutateMock).toHaveBeenCalledWith({ webProvider: 'native' })
  })

  it('shows the Exa key field when Exa is selected', () => {
    setup({ webProvider: 'exa', webProviderIsDefault: false, connected: false })
    render(<WebTab />)

    expect(screen.getByText('Exa API Key')).toBeInTheDocument()
  })
})
