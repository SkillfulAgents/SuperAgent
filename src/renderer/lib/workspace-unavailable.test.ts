import { describe, expect, it } from 'vitest'

import { WorkspaceUnavailableError, isWorkspaceUnavailableError } from './workspace-unavailable'

describe('WorkspaceUnavailableError', () => {
  it.each([
    ['sleeping', 'asleep'],
    ['waking', 'starting up'],
    ['provisioning', 'being set up'],
    ['stopping', 'shutting down'],
    ['unreachable', 'unreachable'],
  ])('describes the %s state as "%s"', (state, described) => {
    const err = new WorkspaceUnavailableError(state)
    expect(err.state).toBe(state)
    expect(err.message).toBe(`Your cloud workspace is ${described}. Please try again in a moment.`)
  })

  it('falls back to a generic message for a state it does not know', () => {
    expect(new WorkspaceUnavailableError('error').message).toContain('not available right now')
  })

  it('is distinguishable from an Error that merely carries the wire code', () => {
    expect(isWorkspaceUnavailableError(new WorkspaceUnavailableError('sleeping'))).toBe(true)
    expect(isWorkspaceUnavailableError(new Error('deployment_unavailable'))).toBe(false)
    expect(isWorkspaceUnavailableError(undefined)).toBe(false)
  })
})
