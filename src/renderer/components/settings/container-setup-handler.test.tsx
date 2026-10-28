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

import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'
import { ContainerSetupHandler } from './container-setup-handler'

/**
 * The dialog sets up the runtime of the Superagent being driven — which is what
 * onboarding is for, on the desktop app and on a self-hosted web deployment
 * alike. A cloud workspace is the one case where its runtime is already
 * provisioned and the machine is out of reach.
 */

function drive(target: 'local' | 'cloud') {
  _resetApiTargetForTest() // the global setup already settled it to 'local'
  setActiveTarget(target, null)
}

beforeEach(() => {
  vi.clearAllMocks()
  drive('local')
})

afterEach(() => {
  cleanup()
  _resetApiTargetForTest()
})

describe('ContainerSetupHandler', () => {
  it('offers to set up the runtime for the Superagent being driven', async () => {
    render(<ContainerSetupHandler />)
    await waitFor(() => expect(screen.getByTestId('container-setup-dialog')).toBeInTheDocument())
  })

  it('stays out of the way when the unavailable runtime is a cloud workspace’s', async () => {
    // Otherwise an outage in the organization's workspace pops a modal on every
    // desktop in the org, telling each person to install Docker on their laptop.
    drive('cloud')

    const { container } = render(<ContainerSetupHandler />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(screen.queryByTestId('container-setup-dialog')).not.toBeInTheDocument()
  })

  it('still runs for a web deployment, whose server IS the machine being set up', async () => {
    // Gating this on an Electron-requiring predicate would have taken it away
    // from every browser, not just from cloud mode.
    render(<ContainerSetupHandler />)
    await waitFor(() => expect(screen.getByTestId('container-setup-dialog')).toBeInTheDocument())
  })
})
