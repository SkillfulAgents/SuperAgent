// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

// The Gamut account and the cloud workspace check, as the Local/Cloud switch reads them; each case sets them.
const { env } = vi.hoisted(() => ({
  env: {
    host: true,
    online: true,
    platform: { isPending: false, data: { connected: true, orgId: 'org1', platformBaseUrl: 'https://gamut.example' } as Record<string, unknown> | undefined },
    workspace: { data: undefined as Record<string, unknown> | undefined, isError: false, isRefetching: false, refetch: vi.fn(async () => ({})) },
    enabled: [] as boolean[],
  },
}))
vi.mock('@renderer/lib/capabilities', () => ({ canUseHostFeatures: () => env.host }))
vi.mock('@renderer/context/connectivity-context', () => ({ useIsOnline: () => env.online }))
vi.mock('./use-platform-auth', () => ({ usePlatformAuthStatus: () => env.platform }))
vi.mock('./use-cloud-workspace', () => ({
  useCloudWorkspace: (enabled: boolean) => {
    env.enabled.push(enabled)
    return env.workspace
  },
}))

import { useCloudTeamBrain, useOffersCloudTeamBrain } from './use-cloud-team-brain'

const workspace = (data: Record<string, unknown>) => {
  env.workspace.data = { found: false, hasValidToken: false, discoveryFailed: false, status: null, deploymentUrl: null, ...data }
}

beforeEach(() => {
  env.host = true
  env.online = true
  env.platform = { isPending: false, data: { connected: true, orgId: 'org1', platformBaseUrl: 'https://gamut.example' } }
  env.workspace = { data: undefined, isError: false, isRefetching: false, refetch: vi.fn(async () => ({})) }
  env.enabled = []
})
afterEach(() => vi.clearAllMocks())

describe('useOffersCloudTeamBrain', () => {
  it('is the desktop on its own computer’s Superagent, and nowhere else', () => {
    expect(renderHook(() => useOffersCloudTeamBrain()).result.current).toBe(true)
    env.host = false
    expect(renderHook(() => useOffersCloudTeamBrain()).result.current).toBe(false)
  })
})

describe('useCloudTeamBrain', () => {
  const state = () => renderHook(() => useCloudTeamBrain(true)).result.current

  it('finds the Team Brain in a workspace that is running and lets this app in, named by its address', () => {
    workspace({ found: true, hasValidToken: true, deploymentUrl: 'https://acme.example.cloud/' })
    expect(state()).toMatchObject({ state: 'found', brain: { workspace: 'acme.example.cloud', location: 'googledrive' } })
  })

  it('says what is in the way: no account, no workspace, one not running, or one out of reach', () => {
    workspace({ status: 'destroyed' })
    expect(state()).toMatchObject({ state: 'not-running', status: 'asleep', platformPage: 'https://gamut.example/dashboard/organizations/org1?tab=cloud' })
    workspace({ status: 'deploying' })
    expect(state()).toMatchObject({ state: 'not-running', status: 'starting' })
    workspace({})
    expect(state()).toMatchObject({ state: 'no-workspace' })
    // Running, but this app couldn't sign in: trying again is the fix, as for a failed check.
    workspace({ found: true, hasValidToken: false })
    expect(state()).toMatchObject({ state: 'unreachable' })
    workspace({ discoveryFailed: true })
    expect(state()).toMatchObject({ state: 'unreachable' })
    env.online = false
    expect(state()).toMatchObject({ state: 'unreachable' })
    env.platform = { isPending: false, data: { connected: false } }
    expect(state()).toMatchObject({ state: 'signed-out' })
  })

  it('asks about the workspace only from this computer, signed in and online, and checks again on request', () => {
    workspace({ found: true, hasValidToken: true })
    state().checkAgain()
    expect(env.workspace.refetch).toHaveBeenCalledTimes(1)
    expect(env.enabled.every(Boolean)).toBe(true)

    env.enabled = []
    env.platform = { isPending: false, data: { connected: false } }
    state().checkAgain()
    expect(env.enabled.some(Boolean)).toBe(false)
    expect(env.workspace.refetch).toHaveBeenCalledTimes(1)
  })

  it('asks nothing while set-up is closed', () => {
    renderHook(() => useCloudTeamBrain(false))
    expect(env.enabled.some(Boolean)).toBe(false)
  })

  it('is still checking while the account or the workspace check is loading', () => {
    env.platform = { isPending: true, data: undefined }
    expect(state()).toMatchObject({ state: 'checking' })
    env.platform = { isPending: false, data: { connected: true, orgId: 'org1' } }
    expect(state()).toMatchObject({ state: 'checking' })
  })
})
