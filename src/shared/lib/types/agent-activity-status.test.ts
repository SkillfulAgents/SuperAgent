import { describe, expect, it } from 'vitest'
import { agentActivity, agentAvatarState, getAgentActivityStatus } from './agent-activity-status'

describe('agentAvatarState', () => {
  const agent = { hasSessionsAwaitingInput: false, hasActiveSessions: false, hasUnreadNotifications: false, status: 'running' as const }

  it('retains the avatar’s attention-first priority: needs input, working, done, sleeping, idle', () => {
    expect(agentAvatarState({ ...agent, hasSessionsAwaitingInput: true, hasActiveSessions: true, hasUnreadNotifications: true })).toBe('needs-input')
    expect(agentAvatarState({ ...agent, hasActiveSessions: true, hasUnreadNotifications: true, status: 'stopped' })).toBe('working')
    expect(agentAvatarState({ ...agent, hasUnreadNotifications: true, status: 'stopped' })).toBe('done')
    expect(agentAvatarState({ ...agent, status: 'stopped' })).toBe('sleeping')
    expect(agentAvatarState(agent)).toBe('idle')
  })

  it('includes loaded session activity', () => {
    expect(agentAvatarState(agent, [{ isActive: true }])).toBe('working')
    expect(agentAvatarState(agent, [{ isAwaitingInput: true }])).toBe('needs-input')
  })
})

it('preserves the runtime indicator’s stopped-first policy', () => {
  expect(getAgentActivityStatus('stopped', true, true)).toBe('sleeping')
  expect(getAgentActivityStatus('running', true, true)).toBe('awaiting_input')
})

it('keeps summary activity when sessions have not caught up', () => {
  expect(agentActivity({ hasActiveSessions: true }, [])).toEqual({ isAwaiting: false, isWorking: true })
  expect(agentActivity({ hasSessionsAwaitingInput: true }, [{ isActive: true }])).toEqual({ isAwaiting: true, isWorking: false })
})
