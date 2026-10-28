// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@renderer/hooks/use-agents', () => {
  const agents = [
    { slug: 'writer', displaySlug: 'writer', name: 'Writer', status: 'stopped', avatar: null },
    { slug: 'planner', displaySlug: 'planner', name: 'Planner', status: 'stopped', avatar: null },
  ]
  return { useAgents: () => ({ data: agents }), useListedAgents: () => ({ data: agents }) }
})
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: false, isAdmin: false }) }))
// The Local/Cloud switch: each case says whether it goes ahead.
const { target } = vi.hoisted(() => ({ target: { switching: false, switchTo: vi.fn(async () => false) } }))
vi.mock('@renderer/hooks/use-target-switch', () => ({ useTargetSwitch: () => target }))
// Nothing is prepared in these steps, so there is no drive to wait on.
vi.mock('@renderer/hooks/use-mounts', () => ({ useAgentMounts: () => ({ data: undefined, isError: false, refetch: vi.fn() }) }))

import { TeamBrainOnboarding } from './team-brain-onboarding'
import { getTeamBrainState, resetTeamBrainState, setTeamBrainState, useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import { TEAM_BRAIN_INITIAL_STATE } from '@renderer/lib/team-brain/team-brain-schema'

const onCancel = vi.fn()

/** Set-up as the desktop pitch opens it, at how. */
function DesktopSetUp() {
  const tb = useTeamBrain()
  return tb.isOnboarding ? <TeamBrainOnboarding open desktop onPrepare={vi.fn()} onDiscard={vi.fn(async () => true)} onStartChat={vi.fn()} onCancel={onCancel} /> : <p data-testid="closed" />
}

beforeEach(() => {
  resetTeamBrainState()
  setTeamBrainState({ ...TEAM_BRAIN_INITIAL_STATE, status: 'onboarding', step: 'how' })
})
afterEach(() => {
  cleanup()
  resetTeamBrainState()
  vi.clearAllMocks()
})

const step = () => screen.getByTestId('team-brain-onboarding-step')
const rail = () => within(screen.getByRole('list', { name: 'Set-up steps' })).getAllByRole('listitem').map((item) => item.textContent)

describe('TeamBrainOnboarding on the desktop', () => {
  it('asks how first, with nothing chosen', () => {
    render(<DesktopSetUp />)
    expect(step()).toHaveAttribute('data-step', 'how')
    expect(screen.getByTestId('team-brain-how-team')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('team-brain-how-here')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('team-brain-next')).toBeDisabled()
    // Before a choice the rail shows the steps both paths share, greyed; the rest grow in once chosen.
    expect(rail()).toEqual(['01Choose how', '02Choose where it lives', '03Choose its agents'])
    const steps = within(screen.getByRole('list', { name: 'Set-up steps' })).getAllByRole('listitem')
    expect(steps.map((item) => item.hasAttribute('data-pending'))).toEqual([false, true, true])
  })

  it('a folder managed elsewhere takes where it lives and its agents, with no schedule or chat', async () => {
    render(<DesktopSetUp />)
    await userEvent.click(screen.getByTestId('team-brain-how-team'))
    expect(rail()).toEqual(['01Choose how', '02Choose where it lives', '03Choose its agents'])
    await userEvent.click(screen.getByTestId('team-brain-next'))
    expect(step()).toHaveAttribute('data-step', 'location')
    expect(getTeamBrainState().path).toBe('team')
    expect(step()).toHaveTextContent('Choose where the folder lives')
  })

  it('setting one up here goes on to set-up’s own steps, and Back returns to how', async () => {
    render(<DesktopSetUp />)
    await userEvent.click(screen.getByTestId('team-brain-how-here'))
    expect(rail()).toEqual(['01Choose how', '02Choose where it lives', '03Choose its agents', '04Set a schedule', '05Context ingestion'])
    await userEvent.click(screen.getByTestId('team-brain-next'))
    expect(step()).toHaveTextContent('Choose where Team Brain knowledge is stored')
    await userEvent.click(screen.getByTestId('team-brain-back'))
    expect(step()).toHaveAttribute('data-step', 'how')
    expect(screen.getByTestId('team-brain-how-here')).toHaveAttribute('aria-checked', 'true')
  })

  it('closes without asking while nothing has been made', async () => {
    render(<DesktopSetUp />)
    await userEvent.click(screen.getByTestId('team-brain-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('sets up in Cloud through the Local/Cloud switch, and closes set-up when it can’t go yet', async () => {
    render(<DesktopSetUp />)
    await userEvent.click(screen.getByTestId('team-brain-how-cloud'))
    expect(screen.getByTestId('team-brain-how-cloud')).toHaveTextContent('Recommended')
    // Its set-up happens in the cloud workspace, so the rail keeps only how.
    expect(rail()).toEqual(['01Choose how'])
    expect(screen.getByTestId('team-brain-next')).toHaveTextContent('Switch to Cloud')
    await userEvent.click(screen.getByTestId('team-brain-next'))
    expect(target.switchTo).toHaveBeenCalledWith('cloud')
    // Refused: the switch says why in a toast or Settings, which set-up would cover, so set-up closes.
    expect(onCancel).toHaveBeenCalled()
  })
})
