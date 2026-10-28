// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const usePwaInstallMock = vi.fn()
const useIsMobileMock = vi.fn()

vi.mock('@renderer/hooks/use-pwa-install', () => ({
  usePwaInstall: () => usePwaInstallMock(),
}))
vi.mock('@renderer/hooks/use-mobile', () => ({
  useIsMobile: () => useIsMobileMock(),
}))

import { PwaInstallBanner } from './pwa-install-banner'

// In jsdom `window.electronAPI` is undefined, so the real isElectron() returns
// false — no need to mock it; this exercises the actual web-path gating.
const base = {
  isStandalone: false,
  canPrompt: false,
  promptInstall: vi.fn(),
  method: 'ios-safari' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useIsMobileMock.mockReturnValue(true)
  usePwaInstallMock.mockReturnValue({ ...base })
})

describe('PwaInstallBanner', () => {
  it('renders nothing on desktop (not a mobile pointer)', () => {
    useIsMobileMock.mockReturnValue(false)
    const { container } = render(<PwaInstallBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing once the app is installed (standalone)', () => {
    usePwaInstallMock.mockReturnValue({ ...base, isStandalone: true })
    const { container } = render(<PwaInstallBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('coaches the manual Add to Home Screen flow on iOS Safari (no button)', () => {
    usePwaInstallMock.mockReturnValue({ ...base, method: 'ios-safari' })
    render(<PwaInstallBanner />)
    expect(screen.getByText('Install Gamut')).toBeInTheDocument()
    expect(screen.getByText(/Add to Home Screen/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
  })

  it('offers a one-tap Install button when a prompt is available and fires it', () => {
    const promptInstall = vi.fn().mockResolvedValue('accepted')
    usePwaInstallMock.mockReturnValue({ ...base, canPrompt: true, method: 'prompt', promptInstall })
    render(<PwaInstallBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(promptInstall).toHaveBeenCalledOnce()
  })

  it('dismiss hides the banner and records the time', () => {
    const { container } = render(<PwaInstallBanner />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(container).toBeEmptyDOMElement()
    const at = Number(localStorage.getItem('pwa-install-banner-dismissed-at'))
    expect(at).toBeGreaterThan(0)
    expect(Date.now() - at).toBeLessThan(5_000)
  })

  it('stays hidden if dismissed within the last week', () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000
    localStorage.setItem('pwa-install-banner-dismissed-at', String(twoDaysAgo))
    const { container } = render(<PwaInstallBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('re-appears once the dismissal is over a week old', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    localStorage.setItem('pwa-install-banner-dismissed-at', String(eightDaysAgo))
    render(<PwaInstallBanner />)
    expect(screen.getByText('Install Gamut')).toBeInTheDocument()
  })
})
