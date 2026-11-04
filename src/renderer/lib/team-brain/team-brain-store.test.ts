// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usesTeamBrain, getTeamBrainState, resetTeamBrainState, restoredSetupOutcome, setTeamBrainState, useTeamBrain } from './team-brain-store'
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
      result.current.setUsesTeamBrain('writer', false)
      result.current.setSchedule('weekly')
    })
    expect(result.current.state).toMatchObject({ location: 'dropbox', step: 'agents', schedule: 'weekly' })
    expect(usesTeamBrain(result.current.state, 'writer')).toBe(false)

    act(() => result.current.cancelSetup())
    expect(getTeamBrainState()).toEqual(TEAM_BRAIN_INITIAL_STATE)
  })

  it('gives every agent Team Brain until turned off', () => {
    setTeamBrainState({ ...TEAM_BRAIN_INITIAL_STATE, agents: { planner: false } })
    expect(usesTeamBrain(getTeamBrainState(), 'writer')).toBe(true)
    expect(usesTeamBrain(getTeamBrainState(), 'planner')).toBe(false)
  })
})

describe('a set-up across page loads', () => {
  const prepared = { agentSlug: 'team-brain-1', volumeId: 'vol-1', brainPath: '/brain' }
  // A page load: fresh modules, the target settled before the store first reads.
  const reload = async () => {
    vi.resetModules()
    ;(await import('@renderer/lib/api-target')).setActiveTarget('local', null)
    return import('./team-brain-store')
  }

  it('resumes where it was left after a reload, and keeps nothing after it ends', async () => {
    setTeamBrainState({ ...TEAM_BRAIN_INITIAL_STATE, status: 'onboarding', step: 'schedule', schedule: 'weekly', prepared })

    const reloaded = await reload()
    expect(reloaded.getTeamBrainState()).toMatchObject({ status: 'onboarding', step: 'schedule', schedule: 'weekly', prepared })

    reloaded.resetTeamBrainState()
    expect((await reload()).getTeamBrainState()).toEqual(TEAM_BRAIN_INITIAL_STATE)
  })

  it('resumes only an agent that still exists and no record claims', () => {
    expect(restoredSetupOutcome('team-brain-1', undefined, true)).toBe('resume')
    expect(restoredSetupOutcome('team-brain-1', 'team-brain-1', true)).toBe('launched')
    expect(restoredSetupOutcome('team-brain-1', 'team-brain-2', true)).toBe('gone')
    expect(restoredSetupOutcome('team-brain-1', undefined, false)).toBe('gone')
  })
})
