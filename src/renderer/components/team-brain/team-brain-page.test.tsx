// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { agents, toast } = vi.hoisted(() => ({
  agents: [
    { slug: 'writer', name: 'Writer', status: 'running', avatar: null },
    { slug: 'planner', name: 'Planner', status: 'stopped', avatar: null },
  ],
  toast: vi.fn(),
}))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgents: () => ({ data: agents }) }))
vi.mock('sonner', () => ({ toast }))

import { TeamBrainPage } from './team-brain-page'
import { getTeamBrainState, resetTeamBrainState } from '@renderer/lib/team-brain/team-brain-store'
import { TEAM_BRAIN_INITIAL_STATE } from '@renderer/lib/team-brain/team-brain-schema'

/** Advance fake time in slices: React only commits between act() scopes. */
async function advance(ms: number, slice = 250) {
  for (let t = 0; t < ms; t += slice) await act(() => vi.advanceTimersByTimeAsync(slice))
}

beforeEach(() => {
  toast.mockClear()
  resetTeamBrainState()
})
afterEach(() => {
  cleanup()
  resetTeamBrainState()
})

describe('TeamBrainPage', () => {
  it('opens on the pitch, and Set up opens the modal at where it lives with nothing chosen', async () => {
    render(<TeamBrainPage />)
    expect(screen.getByTestId('team-brain-intro')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('One source of truth for every agent.')

    await userEvent.click(screen.getByTestId('team-brain-start'))
    expect(screen.getByTestId('team-brain-onboarding')).toBeInTheDocument()
    expect(screen.getByTestId('team-brain-onboarding-step')).toHaveAttribute('data-step', 'location')
    for (const id of ['local', 's3', 'dropbox', 'googledrive']) {
      expect(screen.getByTestId(`team-brain-location-${id}`)).toHaveAttribute('aria-checked', 'false')
    }
    expect(screen.queryByTestId('team-brain-location-gamut')).toBeNull()
    expect(screen.getByTestId('team-brain-next')).toBeDisabled()
  })

  it('walks where it lives, what each agent may do and how often, then hands over to the chat', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ delay: null })
      render(<TeamBrainPage />)
      const step = () => screen.getByTestId('team-brain-onboarding-step')
      await user.click(screen.getByTestId('team-brain-start'))

      // 01: a drive connects first, then counts as chosen.
      await user.click(screen.getByTestId('team-brain-location-googledrive'))
      await advance(800)
      expect(screen.getByTestId('team-brain-location-googledrive')).toHaveAttribute('aria-checked', 'true')
      await user.click(screen.getByTestId('team-brain-next'))

      // 02: every agent reads and writes until told otherwise; pressing the pressed one again takes access away.
      expect(step()).toHaveAttribute('data-step', 'agents')
      expect(screen.getByTestId('team-brain-access-writer-both')).toHaveAttribute('aria-pressed', 'true')
      await user.click(screen.getByTestId('team-brain-access-planner-read'))
      expect(screen.getByTestId('team-brain-access-planner-read')).toHaveAttribute('aria-pressed', 'true')
      await user.click(screen.getByTestId('team-brain-access-planner-read'))
      expect(getTeamBrainState().agentAccess).toEqual({ planner: 'none' })
      await user.click(screen.getByTestId('team-brain-next'))

      // 03: how often, freshness against cost.
      expect(step()).toHaveAttribute('data-step', 'schedule')
      expect(screen.getByTestId('team-brain-schedule-daily')).toHaveAttribute('aria-checked', 'true')
      await user.click(screen.getByTestId('team-brain-schedule-weekly'))
      expect(getTeamBrainState().schedule).toBe('weekly')
      await user.click(screen.getByTestId('team-brain-next'))

      // 04: what the chat covers; starting it closes the modal for now.
      expect(step()).toHaveAttribute('data-step', 'intake')
      await user.click(screen.getByTestId('team-brain-back'))
      expect(step()).toHaveAttribute('data-step', 'schedule')
      await user.click(screen.getByTestId('team-brain-next'))
      await user.click(screen.getByTestId('team-brain-start-chat'))
      expect(screen.queryByTestId('team-brain-onboarding')).toBeNull()
      expect(screen.getByTestId('team-brain-intro')).toBeInTheDocument()
      expect(toast).toHaveBeenCalledWith('The set-up chat is coming soon', expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks before closing, and stopping forgets every choice', async () => {
    render(<TeamBrainPage />)
    await userEvent.click(screen.getByTestId('team-brain-start'))
    await userEvent.click(screen.getByTestId('team-brain-cancel'))
    await userEvent.click(await screen.findByTestId('team-brain-cancel-confirm'))
    expect(screen.queryByTestId('team-brain-onboarding')).toBeNull()
    expect(getTeamBrainState()).toEqual(TEAM_BRAIN_INITIAL_STATE)
  })
})
