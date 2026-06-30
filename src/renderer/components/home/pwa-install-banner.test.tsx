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

  it('dismiss hides the banner and persists the choice', () => {
    const { container } = render(<PwaInstallBanner />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(container).toBeEmptyDOMElement()
    expect(localStorage.getItem('pwa-install-banner-dismissed')).toBe('1')
  })

  it('stays hidden if previously dismissed', () => {
    localStorage.setItem('pwa-install-banner-dismissed', '1')
    const { container } = render(<PwaInstallBanner />)
    expect(container).toBeEmptyDOMElement()
  })
})
