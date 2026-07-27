// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  runtimeStatus: { runtimeReadiness: { status: 'RUNTIME_UNAVAILABLE' as string } },
  settings: { runnerAvailability: [{ available: false }] },
  userSettings: { setupCompleted: true },
}))

vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: state.userSettings }),
}))
vi.mock('@renderer/hooks/use-runtime-status', () => ({
  useRuntimeStatus: () => ({ data: state.runtimeStatus }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({ useSettings: () => ({ data: state.settings }) }))

vi.mock('@renderer/components/settings/container-setup-dialog', () => ({
  ContainerSetupDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="container-setup-dialog" /> : null,
}))

const { mockCanUseHostFeatures } = vi.hoisted(() => ({
  mockCanUseHostFeatures: vi.fn(() => true),
}))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: mockCanUseHostFeatures }))

import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { ContainerSetupHandler } from './container-setup-handler'

/**
 * Runtime readiness describes whichever Superagent is being driven, but this
 * dialog is about fixing *this* computer — it starts a local runner and links
 * to the Docker Desktop download.
 */

beforeEach(() => {
  vi.clearAllMocks()
  mockCanUseHostFeatures.mockReturnValue(true)
})

afterEach(() => cleanup())

describe('ContainerSetupHandler', () => {
  it('offers to set up the runtime when this computer runs the agents', async () => {
    render(<ContainerSetupHandler />)
    await waitFor(() => expect(screen.getByTestId('container-setup-dialog')).toBeInTheDocument())
  })

  it('stays out of the way when the unavailable runtime is a cloud workspace’s', async () => {
    // Otherwise an outage in the organization's workspace pops a modal on every
    // desktop in the org, telling each person to install Docker on their laptop.
    mockCanUseHostFeatures.mockReturnValue(false)

    const { container } = render(<ContainerSetupHandler />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(screen.queryByTestId('container-setup-dialog')).not.toBeInTheDocument()
  })
})
