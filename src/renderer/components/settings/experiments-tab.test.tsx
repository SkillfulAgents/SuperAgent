// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'

const state = {
  experiments: [] as { id: string; name: string; description: string }[],
  switches: undefined as Record<string, boolean> | undefined,
}
const updateUserSettings = vi.fn()
const track = vi.fn()

vi.mock('@shared/lib/experiments/registry', () => ({
  get EXPERIMENTS() { return state.experiments },
}))
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track }),
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: { experiments: state.switches }, isLoading: false }),
  useUpdateUserSettings: () => ({ mutate: updateUserSettings }),
}))

import { ExperimentsTab } from './experiments-tab'

beforeEach(() => {
  state.experiments = []
  state.switches = undefined
  updateUserSettings.mockReset()
  track.mockReset()
})

describe('ExperimentsTab', () => {
  it('says so when there are no experiments', () => {
    renderWithProviders(<ExperimentsTab />)
    expect(screen.getByTestId('experiments-empty')).toHaveTextContent('No experiments right now.')
  })

  it('lists each experiment with its own switch, reflecting what the user stored', () => {
    state.experiments = [
      { id: 'alpha', name: 'Alpha', description: 'The first one.' },
      { id: 'beta', name: 'Beta', description: 'The second one.' },
    ]
    state.switches = { beta: true }
    renderWithProviders(<ExperimentsTab />)
    expect(screen.getByText('The first one.')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Alpha' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: 'Beta' })).toHaveAttribute('aria-checked', 'true')
  })

  it('toggling writes only that experiment', () => {
    state.experiments = [{ id: 'alpha', name: 'Alpha', description: 'The first one.' }]
    renderWithProviders(<ExperimentsTab />)
    fireEvent.click(screen.getByRole('switch', { name: 'Alpha' }))
    expect(updateUserSettings).toHaveBeenCalledWith(
      { experiments: { alpha: true } },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    )
  })

  it('records the toggle once the setting is saved, and the failure when it is not', () => {
    state.experiments = [{ id: 'alpha', name: 'Alpha', description: 'The first one.' }]
    renderWithProviders(<ExperimentsTab />)
    fireEvent.click(screen.getByRole('switch', { name: 'Alpha' }))
    const [, options] = updateUserSettings.mock.calls[0]
    options.onSuccess()
    expect(track).toHaveBeenCalledWith('experiment_toggled', { experiment_key: 'alpha', enabled: true })
    options.onError()
    expect(track).toHaveBeenCalledWith('experiment_toggle_failed', { experiment_key: 'alpha', enabled: true })
  })
})
