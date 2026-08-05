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
  ProviderApiKeyInput: ({ layout }: { layout?: 'stacked' | 'rows' }) => (
    <div data-testid="api-key-input" data-layout={layout ?? 'stacked'} />
  ),
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

  it('marks "(default)" on the selected card only when isDefault', () => {
    setup({ webProvider: 'platform', webProviderIsDefault: true, connected: true })
    const { unmount } = render(<WebTab />)
    expect(screen.getByRole('radio', { name: /Gamut/i })).toBeChecked()
    expect(screen.getByText('(default)')).toBeInTheDocument()
    unmount()

    setup({ webProvider: 'exa', webProviderIsDefault: false, connected: true })
    render(<WebTab />)
    expect(screen.getByRole('radio', { name: /Exa/i })).toBeChecked()
    expect(screen.queryByText('(default)')).not.toBeInTheDocument()
  })

  it('disables the Gamut card when not signed into Gamut', () => {
    setup({ webProvider: 'native', webProviderIsDefault: true, connected: false })
    render(<WebTab />)

    expect(screen.getByRole('radio', { name: /Gamut/i })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Requires Gamut account')).toBeInTheDocument()
  })

  it('pins the chosen vendor to the single webProvider field', async () => {
    setup({ webProvider: 'platform', webProviderIsDefault: true, connected: true })
    const user = userEvent.setup()
    render(<WebTab />)

    await user.click(screen.getByRole('radio', { name: /Native/i }))

    expect(mutateMock).toHaveBeenCalledWith({ webProvider: 'native' })
  })

  it('expands the Exa card config only when Exa is selected', () => {
    setup({ webProvider: 'native', webProviderIsDefault: true, connected: false })
    const { unmount } = render(<WebTab />)
    expect(screen.queryByTestId('api-key-input')).not.toBeInTheDocument()
    // The docs link lives in the card description, visible without selection
    expect(screen.getByRole('link', { name: /View Exa docs/i })).toBeInTheDocument()
    unmount()

    setup({ webProvider: 'exa', webProviderIsDefault: false, connected: false })
    render(<WebTab />)
    expect(screen.getByTestId('api-key-input')).toBeInTheDocument()
    expect(screen.getByTestId('api-key-input')).toHaveAttribute('data-layout', 'stacked')
  })
})
