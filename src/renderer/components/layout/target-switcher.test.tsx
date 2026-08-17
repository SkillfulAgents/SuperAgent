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

  // The options are named by tooltip, not by button text: text inside the
  // button would have to appear on hover, moving the option next to it out from
  // under a cursor already travelling toward it.
  it('names the options without rendering text inside the buttons', () => {
    state()
    render(<TargetSwitcher />)

    expect(screen.getByRole('button', { name: 'Local Agents (This computer)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cloud Agents' })).toBeInTheDocument()
    expect(screen.getByTestId('target-option-local')).toHaveTextContent('')
    expect(screen.getByTestId('target-option-cloud')).toHaveTextContent('')
  })

  // The name does not change with state — `aria-pressed` carries that, and a
  // name that moved with it would be announced twice over.
  it('names each option the same whichever one is current', async () => {
    state({ current: 'cloud' })
    render(<TargetSwitcher />)

    await userEvent.hover(screen.getByTestId('target-option-cloud'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Cloud Agents')

    await userEvent.hover(screen.getByTestId('target-option-local'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Local Agents (This computer)')
  })

  it('switches on click', async () => {
    state({ current: 'local' })
    render(<TargetSwitcher />)

    await userEvent.click(screen.getByTestId('target-option-cloud'))

    expect(switchTo).toHaveBeenCalledWith('cloud')
  })

  // Marked disabled rather than `disabled`, so the button still emits the
  // pointer events its tooltip needs — see the comment on the button.
  it('reports itself disabled while a switch is in flight, and still explains itself', async () => {
    state({ switching: true })
    render(<TargetSwitcher />)

    const cloud = screen.getByTestId('target-option-cloud')
    expect(cloud).toHaveAttribute('aria-disabled', 'true')

    await userEvent.hover(cloud)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Switching…')
  })

  it('offers a reason to pick each option', async () => {
    state({ current: 'local' })
    render(<TargetSwitcher />)

    await userEvent.hover(screen.getByTestId('target-option-cloud'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Run 24/7. Access anywhere. Share and collaborate with your team',
    )
  })
})
