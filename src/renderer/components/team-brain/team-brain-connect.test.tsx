// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CloudTeamBrainLookup } from '@renderer/hooks/use-cloud-team-brain'

// What looking for the cloud's Team Brain finds, set by each case; set-up's modal and both stores run for real.
const { lookup, openSettings, target } = vi.hoisted(() => ({
  lookup: { value: { state: 'checking' } as CloudTeamBrainLookup, checkAgain: vi.fn() },
  openSettings: vi.fn(),
  target: { switching: false, switchTo: vi.fn() },
}))
vi.mock('@renderer/hooks/use-cloud-team-brain', () => ({ useCloudTeamBrain: () => ({ ...lookup.value, checkAgain: lookup.checkAgain }) }))
vi.mock('@renderer/hooks/use-agents', () => {
  const agents = [
    { slug: 'writer', displaySlug: 'writer', name: 'Writer', status: 'stopped', avatar: null },
    { slug: 'planner', displaySlug: 'planner', name: 'Planner', status: 'stopped', avatar: null },
  ]
  return { useAgents: () => ({ data: agents }), useListedAgents: () => ({ data: agents }) }
})
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: false, isAdmin: false }) }))
vi.mock('@renderer/context/dialog-context', () => ({ useDialogs: () => ({ openSettings }) }))
vi.mock('@renderer/hooks/use-target-switch', () => ({ useTargetSwitch: () => target }))
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl: vi.fn() }))

import { TeamBrainOnboarding } from './team-brain-onboarding'
import { getCloudConnection, resetCloudConnection } from '@renderer/lib/team-brain/team-brain-cloud'
import { cloudTeamBrain } from '@renderer/lib/team-brain/team-brain-cloud-fixture'
import { getTeamBrainState, resetTeamBrainState, setTeamBrainState, useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import { TEAM_BRAIN_INITIAL_STATE } from '@renderer/lib/team-brain/team-brain-schema'

const onCancel = vi.fn()

/** Set-up as the desktop pitch opens it, at how. */
function DesktopSetUp() {
  const tb = useTeamBrain()
  return tb.isOnboarding ? <TeamBrainOnboarding open desktop onPrepare={vi.fn()} onStartChat={vi.fn()} onCancel={onCancel} /> : <p data-testid="closed" />
}

function start() {
  render(<DesktopSetUp />)
}

beforeEach(() => {
  resetTeamBrainState()
  resetCloudConnection()
  // As the desktop pitch's button opens it.
  setTeamBrainState({ ...TEAM_BRAIN_INITIAL_STATE, status: 'onboarding', step: 'how' })
  lookup.value = { state: 'checking' }
})
afterEach(() => {
  cleanup()
  resetTeamBrainState()
  resetCloudConnection()
  vi.clearAllMocks()
})

const step = () => screen.getByTestId('team-brain-onboarding-step')
const rail = () => within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem').map((item) => item.textContent)

describe('TeamBrainOnboarding on the desktop', () => {
  it('asks how first, and with a Team Brain in the cloud, connecting is chosen and the rail shows its two steps', () => {
    lookup.value = { state: 'found', brain: cloudTeamBrain('acme.gamut.cloud') }
    start()
    expect(step()).toHaveAttribute('data-step', 'how')
    expect(screen.getByTestId('team-brain-how-cloud')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('team-brain-how-cloud')).toHaveTextContent('Recommended')
    expect(screen.getByTestId('team-brain-how-found')).toHaveTextContent('acme.gamut.cloud')
    expect(screen.getByTestId('team-brain-how-found')).toHaveTextContent('Google Drive · Shared drives / Team Brain')
    expect(rail()).toEqual(['01Choose how', '02Choose its agents'])
    expect(screen.getByTestId('team-brain-next')).toHaveTextContent('Next: Agents')
  })

  it('without one, says why, and setting one up here goes on to set-up’s own steps', async () => {
    lookup.value = { state: 'signed-out' }
    start()
    expect(screen.getByTestId('team-brain-how-cloud')).toBeDisabled()
    expect(screen.getByTestId('team-brain-how-lookup')).toHaveAttribute('data-state', 'signed-out')
    expect(screen.getByTestId('team-brain-next')).toBeDisabled()

    await userEvent.click(screen.getByTestId('team-brain-how-here'))
    expect(rail()).toEqual(['01Choose how', '02Choose where it lives', '03Choose its agents', '04Set a schedule', '05Context ingestion'])
    await userEvent.click(screen.getByTestId('team-brain-next'))
    expect(step()).toHaveAttribute('data-step', 'location')
    expect(getTeamBrainState().path).toBe('here')
    await userEvent.click(screen.getByTestId('team-brain-back'))
    expect(step()).toHaveAttribute('data-step', 'how')
    expect(screen.getByTestId('team-brain-how-here')).toHaveAttribute('aria-checked', 'true')
  })

  it('leaves set-up for Account settings to sign in, and switches to Cloud where the workspace has no Team Brain', async () => {
    lookup.value = { state: 'signed-out' }
    const { rerender } = render(<DesktopSetUp />)
    await userEvent.click(screen.getByTestId('team-brain-how-sign-in'))
    expect(onCancel).toHaveBeenCalled()
    expect(openSettings).toHaveBeenCalledWith('platform')

    lookup.value = { state: 'no-brain' }
    rerender(<DesktopSetUp />)
    await userEvent.click(screen.getByTestId('team-brain-how-switch'))
    expect(target.switchTo).toHaveBeenCalledWith('cloud')
  })

  it('connects to the cloud’s Team Brain for the agents chosen, and set-up ends', async () => {
    const brain = cloudTeamBrain('acme.gamut.cloud')
    lookup.value = { state: 'found', brain }
    start()
    await userEvent.click(screen.getByTestId('team-brain-next'))
    expect(step()).toHaveAttribute('data-step', 'readers')
    // Every agent here reads it until switched off.
    const list = screen.getByTestId('team-brain-agent-access')
    expect(within(list).getAllByRole('switch').map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'true'])
    await userEvent.click(screen.getByTestId('team-brain-agent-planner'))

    await userEvent.click(screen.getByTestId('team-brain-connect-confirm'))
    expect(screen.getByTestId('team-brain-connect-confirm')).toHaveTextContent('Connecting')
    await waitFor(() => expect(screen.getByTestId('closed')).toBeInTheDocument())
    expect(getCloudConnection()).toMatchObject({ connected: { brain }, agents: { planner: false }, everyAgent: false })
    expect(getTeamBrainState().status).toBe('off')
  })

  it('closes without asking while nothing has been made', async () => {
    lookup.value = { state: 'found', brain: cloudTeamBrain('acme.gamut.cloud') }
    start()
    await userEvent.click(screen.getByTestId('team-brain-next'))
    await userEvent.click(screen.getByTestId('team-brain-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(getCloudConnection().connected).toBeNull()
  })
})
