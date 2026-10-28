import { describe, expect, it } from 'vitest'
import { teamBrainSteps } from './team-brain-schema'

describe('teamBrainSteps', () => {
  it('is today’s set-up off the desktop, whatever the path', () => {
    expect(teamBrainSteps(false, null)).toEqual(['location', 'agents', 'schedule', 'intake'])
    expect(teamBrainSteps(false, 'team')).toEqual(['location', 'agents', 'schedule', 'intake'])
  })
  it('on the desktop asks how first, then takes the chosen path’s steps', () => {
    expect(teamBrainSteps(true, null)).toEqual(['how'])
    expect(teamBrainSteps(true, 'cloud')).toEqual(['how'])
    expect(teamBrainSteps(true, 'team')).toEqual(['how', 'location', 'agents'])
    expect(teamBrainSteps(true, 'here')).toEqual(['how', 'location', 'agents', 'schedule', 'intake'])
  })
})
