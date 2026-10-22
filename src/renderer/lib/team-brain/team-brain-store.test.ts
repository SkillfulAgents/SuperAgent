// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { agentAccessOf, getTeamBrainState, resetTeamBrainState, setTeamBrainState, useTeamBrain } from './team-brain-store'
import { TEAM_BRAIN_INITIAL_STATE } from './team-brain-schema'

beforeEach(() => resetTeamBrainState())
afterEach(() => resetTeamBrainState())

describe('useTeamBrain', () => {
  it('starts off, then opens set-up at where it lives with nothing chosen', () => {
    const { result } = renderHook(() => useTeamBrain())
    expect(result.current.state).toEqual(TEAM_BRAIN_INITIAL_STATE)
    expect(result.current.isOnboarding).toBe(false)

    act(() => result.current.start())
    expect(result.current.isOnboarding).toBe(true)
    expect(result.current.state).toMatchObject({ step: 'location', location: null })
  })

  it('keeps the modal’s choices, and forgets them all on cancel', () => {
    const { result } = renderHook(() => useTeamBrain())
    act(() => {
      result.current.start()
      result.current.setLocation('dropbox')
      result.current.goToStep('agents')
      result.current.setAgentAccess('writer', 'read')
      result.current.setSchedule('weekly')
    })
    expect(result.current.state).toMatchObject({ location: 'dropbox', step: 'agents', schedule: 'weekly' })
    expect(agentAccessOf(result.current.state, 'writer')).toBe('read')

    act(() => result.current.cancelSetup())
    expect(getTeamBrainState()).toEqual(TEAM_BRAIN_INITIAL_STATE)
  })

  it('lets every agent read and write until told otherwise', () => {
    setTeamBrainState({ ...TEAM_BRAIN_INITIAL_STATE, agentAccess: { planner: 'none' } })
    expect(agentAccessOf(getTeamBrainState(), 'writer')).toBe('both')
    expect(agentAccessOf(getTeamBrainState(), 'planner')).toBe('none')
  })
})
