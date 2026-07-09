// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Shims for Radix Select in jsdom.
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

// ProviderApiKeyInput is only rendered when the active vendor is Exa; stub it so these tests never
// depend on its network/query wiring.
vi.mock('./provider-api-key-input', () => ({
  ProviderApiKeyInput: () => null,
}))

import { WebTab } from './web-tab'

function setup(options?: {
  webProvider?: string
  effectiveWebProvider?: string
  connected?: boolean
}) {
  useSettingsMock.mockReturnValue({
    isLoading: false,
    data: {
      webProvider: options?.webProvider,
      effectiveWebProvider: options?.effectiveWebProvider ?? 'platform',
    },
  })
  platformAuthMock.mockReturnValue({ data: { connected: options?.connected ?? false } })
}

describe('WebTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the resolved effective vendor marked "(default)" when no explicit choice is stored', () => {
    setup({ webProvider: undefined, effectiveWebProvider: 'platform', connected: true })
    render(<WebTab />)

    // The trigger reflects the resolved vendor as a concrete value (not an abstract "automatic" row),
    // marked as the auto-picked default.
    expect(screen.getByRole('combobox')).toHaveTextContent('Platform')
    expect(screen.getByText('(default)')).toBeInTheDocument()
  })

  it('shows an explicit choice without the "(default)" marker', () => {
    setup({ webProvider: 'exa', effectiveWebProvider: 'exa', connected: true })
    render(<WebTab />)

    expect(screen.getByRole('combobox')).toHaveTextContent('Exa')
    expect(screen.queryByText('(default)')).not.toBeInTheDocument()
  })

  it('offers only concrete vendors - there is no "Default (automatic)" option', async () => {
    setup({ webProvider: undefined, effectiveWebProvider: 'platform', connected: true })
    const user = userEvent.setup()
    render(<WebTab />)

    await user.click(screen.getByRole('combobox'))
    expect(await screen.findByRole('option', { name: /^Native$/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Exa/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Platform/i })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Default \(automatic\)/i })).not.toBeInTheDocument()
  })

  it('disables the Platform option when not signed into Gamut', async () => {
    setup({ webProvider: undefined, effectiveWebProvider: 'native', connected: false })
    const user = userEvent.setup()
    render(<WebTab />)

    await user.click(screen.getByRole('combobox'))
    const platformOption = await screen.findByRole('option', { name: /Platform/i })
    expect(platformOption).toHaveAttribute('aria-disabled', 'true')
  })

  it('enables the Platform option when signed into Gamut', async () => {
    setup({ webProvider: undefined, effectiveWebProvider: 'platform', connected: true })
    const user = userEvent.setup()
    render(<WebTab />)

    await user.click(screen.getByRole('combobox'))
    const platformOption = await screen.findByRole('option', { name: /Platform/i })
    expect(platformOption).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('pins the chosen vendor to the single webProvider field', async () => {
    setup({ webProvider: undefined, effectiveWebProvider: 'platform', connected: true })
    const user = userEvent.setup()
    render(<WebTab />)

    // The default shows Platform; picking a different vendor pins it.
    // (Re-selecting the already-shown default is a Radix no-op by design - the default already applies.)
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: /^Native$/i }))

    expect(mutateMock).toHaveBeenCalledWith({ webProvider: 'native' })
  })

  it('shows the Exa key field when Exa is the resolved default, not only an explicit pick', () => {
    setup({ webProvider: undefined, effectiveWebProvider: 'exa', connected: false })
    render(<WebTab />)

    expect(screen.getByText('Exa API Key')).toBeInTheDocument()
  })

  it('warns when Platform is explicitly selected but signed out of Gamut', () => {
    setup({ webProvider: 'platform', effectiveWebProvider: 'platform', connected: false })
    render(<WebTab />)
    expect(screen.getByText(/Platform is selected but you are not signed into Gamut/i)).toBeInTheDocument()
  })

  it('shows no such warning when Platform is selected and signed in', () => {
    setup({ webProvider: 'platform', effectiveWebProvider: 'platform', connected: true })
    render(<WebTab />)
    expect(screen.queryByText(/Platform is selected but you are not signed into Gamut/i)).not.toBeInTheDocument()
  })
})
