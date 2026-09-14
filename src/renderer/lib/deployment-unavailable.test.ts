import { describe, it, expect } from 'vitest'
import { DeploymentUnavailableError, deploymentUnavailableFromResponse } from './deployment-unavailable'

describe('deploymentUnavailableFromResponse', () => {
  it('returns a typed error carrying the route state for a router 503 body', () => {
    const err = deploymentUnavailableFromResponse(503, { error: 'deployment_unavailable', state: 'waking' })
    expect(err).toBeInstanceOf(DeploymentUnavailableError)
    expect(err?.state).toBe('waking')
    expect(err?.message).toBe('Workspace is waking up. Try again in a moment.')
  })

  it('falls back to a generic message that still names an unknown state', () => {
    const err = deploymentUnavailableFromResponse(503, { error: 'deployment_unavailable', state: 'draining' })
    expect(err?.message).toBe('Workspace is not ready (draining). Try again shortly.')
  })

  it('uses "unknown" when the body omits state', () => {
    expect(deploymentUnavailableFromResponse(503, { error: 'deployment_unavailable' })?.state).toBe('unknown')
  })

  it('returns null for a 503 with a different body', () => {
    expect(deploymentUnavailableFromResponse(503, { error: 'upstream_timeout' })).toBeNull()
    expect(deploymentUnavailableFromResponse(503, 'not json')).toBeNull()
    expect(deploymentUnavailableFromResponse(503, {})).toBeNull()
  })

  it('returns null for the same body on a non-503 status', () => {
    expect(deploymentUnavailableFromResponse(500, { error: 'deployment_unavailable', state: 'waking' })).toBeNull()
  })
})
