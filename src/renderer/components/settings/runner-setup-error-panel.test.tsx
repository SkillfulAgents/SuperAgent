// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RunnerSetupErrorPanel, getRunnerSetupPayload } from './runner-setup-error-panel'
import { renderWithProviders } from '@renderer/test/test-utils'
import { RunnerSetupFailedError } from '@renderer/hooks/use-settings'
import type { RunnerSetupRemediation } from '@shared/lib/container/wsl2-setup-errors'

const bios: RunnerSetupRemediation = {
  kind: 'virt-disabled-in-bios',
  title: 'Virtualization is disabled in BIOS',
  remediation: 'Enable Intel VT-x or AMD-V in firmware.',
  steps: [
    { label: 'Reboot into BIOS setup.' },
    { label: 'Enable Intel Virtualization Technology.' },
    { label: 'Verify:', command: 'systeminfo | Select-String "Virtualization Enabled"' },
  ],
  docsUrl: 'https://aka.ms/enablevirtualization',
  originalStderr: 'HCS_E_HYPERV_NOT_INSTALLED',
  userResolvable: true,
}

const vmp: RunnerSetupRemediation = {
  kind: 'vmp-feature-missing',
  title: 'Virtual Machine Platform is not enabled',
  remediation: 'Enable it, then reboot.',
  steps: [
    { label: 'Run as admin:', command: 'wsl.exe --install --no-distribution', elevated: true },
  ],
  docsUrl: null,
  originalStderr: '',
  userResolvable: true,
}

describe('getRunnerSetupPayload', () => {
  it('extracts payload from RunnerSetupFailedError', () => {
    expect(getRunnerSetupPayload(new RunnerSetupFailedError(bios))).toEqual(bios)
  })

  it('returns null for generic errors', () => {
    expect(getRunnerSetupPayload(new Error('generic'))).toBeNull()
    expect(getRunnerSetupPayload(null)).toBeNull()
    expect(getRunnerSetupPayload(undefined)).toBeNull()
  })
})

describe('RunnerSetupErrorPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders nothing for a generic error', () => {
    const { container } = renderWithProviders(<RunnerSetupErrorPanel error={new Error('generic')} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders title, remediation, and every step', () => {
    renderWithProviders(<RunnerSetupErrorPanel error={new RunnerSetupFailedError(bios)} />)

    expect(screen.getByText(bios.title)).toBeInTheDocument()
    expect(screen.getByText(bios.remediation)).toBeInTheDocument()
    for (const step of bios.steps) {
      expect(screen.getByText(step.label)).toBeInTheDocument()
      if (step.command) {
        expect(screen.getByText(step.command)).toBeInTheDocument()
      }
    }
  })

  it('shows Admin badge on elevated steps', () => {
    renderWithProviders(<RunnerSetupErrorPanel error={new RunnerSetupFailedError(vmp)} />)
    expect(screen.getByText('Admin')).toBeInTheDocument()
  })

  it('omits Admin badge when no step is elevated', () => {
    renderWithProviders(<RunnerSetupErrorPanel error={new RunnerSetupFailedError(bios)} />)
    expect(screen.queryByText('Admin')).not.toBeInTheDocument()
  })

  it('copies all step commands to clipboard joined by newline', async () => {
    // userEvent.setup() installs its own clipboard mock — spy *after* to hook the
    // real call the component makes.
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)

    renderWithProviders(<RunnerSetupErrorPanel error={new RunnerSetupFailedError(bios)} />)

    await user.click(screen.getByRole('button', { name: /copy commands/i }))
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith('systeminfo | Select-String "Virtualization Enabled"')
  })

  it('does not crash when navigator.clipboard is undefined', async () => {
    const user = userEvent.setup()
    const originalClipboard = navigator.clipboard
    // Force clipboard to undefined to simulate insecure-context / restricted envs.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    try {
      renderWithProviders(<RunnerSetupErrorPanel error={new RunnerSetupFailedError(bios)} />)
      // Should not throw.
      await user.click(screen.getByRole('button', { name: /copy commands/i }))
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true })
    }
  })

  it('does not crash when clipboard.writeText rejects', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Document not focused'))

    renderWithProviders(<RunnerSetupErrorPanel error={new RunnerSetupFailedError(bios)} />)
    // Should not throw; the rejection must be swallowed internally.
    await user.click(screen.getByRole('button', { name: /copy commands/i }))
    // Give microtasks a chance to settle so unhandledrejection would have fired.
    await new Promise((r) => setTimeout(r, 0))
  })

  it('hides Copy commands button when no steps have a command', () => {
    const noCommands: RunnerSetupRemediation = {
      ...bios,
      steps: [{ label: 'Just reboot' }],
    }
    renderWithProviders(<RunnerSetupErrorPanel error={new RunnerSetupFailedError(noCommands)} />)
    expect(screen.queryByRole('button', { name: /copy commands/i })).not.toBeInTheDocument()
  })

  it('opens docs URL when docs button clicked', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    renderWithProviders(<RunnerSetupErrorPanel error={new RunnerSetupFailedError(bios)} />)

    await userEvent.setup().click(screen.getByRole('button', { name: /view docs/i }))
    expect(openSpy).toHaveBeenCalledWith(bios.docsUrl, '_blank', 'noopener,noreferrer')
  })

  it('hides docs button when docsUrl is null', () => {
    renderWithProviders(<RunnerSetupErrorPanel error={new RunnerSetupFailedError(vmp)} />)
    expect(screen.queryByRole('button', { name: /view docs/i })).not.toBeInTheDocument()
  })

  it('renders collapsible technical details with the original stderr', () => {
    renderWithProviders(<RunnerSetupErrorPanel error={new RunnerSetupFailedError(bios)} />)
    expect(screen.getByText('Technical details')).toBeInTheDocument()
    expect(screen.getByText(bios.originalStderr)).toBeInTheDocument()
  })

  it('hides technical details when stderr is empty', () => {
    renderWithProviders(<RunnerSetupErrorPanel error={new RunnerSetupFailedError(vmp)} />)
    expect(screen.queryByText('Technical details')).not.toBeInTheDocument()
  })
})
