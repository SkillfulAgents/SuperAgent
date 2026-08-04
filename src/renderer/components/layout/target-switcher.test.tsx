// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseTargetSwitch } = vi.hoisted(() => ({ mockUseTargetSwitch: vi.fn() }))
vi.mock('@renderer/hooks/use-target-switch', () => ({ useTargetSwitch: mockUseTargetSwitch }))

import { TargetSwitcher } from './target-switcher'

const switchTo = vi.fn()

function state(overrides: Record<string, unknown> = {}) {
  mockUseTargetSwitch.mockReturnValue({
    current: 'local',
    available: true,
    switching: false,
    switchTo,
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('TargetSwitcher', () => {
  it('renders nothing when there is no cloud workspace to switch to', () => {
    state({ available: false })
    render(<TargetSwitcher />)
    expect(screen.queryByTestId('target-switcher')).not.toBeInTheDocument()
  })

  it('marks the local option as current when driving this computer', () => {
    state({ current: 'local' })
    render(<TargetSwitcher />)

    expect(screen.getByTestId('target-option-local')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('target-option-cloud')).toHaveAttribute('aria-pressed', 'false')
  })

  it('marks the cloud option as current when driving the workspace', () => {
    state({ current: 'cloud' })
    render(<TargetSwitcher />)

    expect(screen.getByTestId('target-option-cloud')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('target-option-local')).toHaveAttribute('aria-pressed', 'false')
  })

  it('switches on click', async () => {
    state({ current: 'local' })
    render(<TargetSwitcher />)

    await userEvent.click(screen.getByTestId('target-option-cloud'))

    expect(switchTo).toHaveBeenCalledWith('cloud')
  })

  it('is disabled while a switch is in flight', async () => {
    state({ switching: true })
    render(<TargetSwitcher />)

    expect(screen.getByTestId('target-option-cloud')).toBeDisabled()
    await userEvent.click(screen.getByTestId('target-option-cloud'))
    expect(switchTo).not.toHaveBeenCalled()
  })
})
