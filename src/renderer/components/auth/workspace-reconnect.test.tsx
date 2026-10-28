// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const { mockSwitchToLocalTarget } = vi.hoisted(() => ({
  mockSwitchToLocalTarget: vi.fn(async () => {}),
}))
vi.mock('@renderer/lib/api-target', () => ({ switchToLocalTarget: mockSwitchToLocalTarget }))

import { WorkspaceReconnect } from './workspace-reconnect'

/**
 * This screen replaces the whole app when a cloud workspace cannot be reached,
 * so its one button is the only way out. Everything here is about that button
 * still being there afterwards.
 */
describe('WorkspaceReconnect', () => {
  it('returns the app to the local Superagent', async () => {
    render(<WorkspaceReconnect />)

    await userEvent.click(screen.getByRole('button'))

    expect(mockSwitchToLocalTarget).toHaveBeenCalled()
  })

  it('gives the escape hatch back when the switch fails', async () => {
    mockSwitchToLocalTarget.mockRejectedValueOnce(new Error('settings are read-only'))
    render(<WorkspaceReconnect />)

    await userEvent.click(screen.getByRole('button'))

    // A latched "Switching…" here would strand the user in a workspace the app
    // has already failed to reach.
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled())
    expect(screen.getByRole('button')).toHaveTextContent('Use this computer instead')
  })

  it('says why, on the screen — no toaster is mounted here', async () => {
    mockSwitchToLocalTarget.mockRejectedValueOnce(new Error('settings are read-only'))
    render(<WorkspaceReconnect />)

    await userEvent.click(screen.getByRole('button'))

    await waitFor(() =>
      expect(screen.getByTestId('workspace-reconnect-error')).toHaveTextContent(
        'settings are read-only',
      ),
    )
  })
})
