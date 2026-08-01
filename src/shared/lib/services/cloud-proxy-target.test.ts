import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readCloudWorkspaceRecord } from '@shared/lib/platform-auth/cloud-workspace-record'
import { getCloudWorkspace } from './cloud-workspace-service'
import {
  _resetCloudProxyRefreshForTest,
  refreshCloudProxyTarget,
  resolveCloudProxyTarget,
} from './cloud-proxy-target'

vi.mock('@shared/lib/platform-auth/cloud-workspace-record', () => ({
  readCloudWorkspaceRecord: vi.fn(),
}))

vi.mock('./cloud-workspace-service', () => ({
  getCloudWorkspace: vi.fn(),
  // Stands in for the real policy (covered in cloud-workspace-service.test.ts)
  // so this file exercises whether the target consults it, not what it decides.
  isDeploymentUrlAllowed: (url: string) => url.startsWith('https://'),
}))

const mockReadRecord = vi.mocked(readCloudWorkspaceRecord)
const mockGetCloudWorkspace = vi.mocked(getCloudWorkspace)

/** A cloud-workspace status; `hasValidToken` is the only field consulted. */
function status(overrides: { hasValidToken: boolean }) {
  return {
    available: true,
    found: true,
    deploymentUrl: 'https://ws.example.com',
    orgId: 'org_1',
    discoveryFailed: false,
    ...overrides,
  } as Awaited<ReturnType<typeof getCloudWorkspace>>
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    deploymentUrl: 'https://ws.example.com',
    orgId: 'org_1',
    token: 'deployment-token',
    tokenPreview: 'dep…',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    userId: 'usr_1',
    memberId: 'sub_1',
    tokenFingerprint: 'fp',
    ...overrides,
  } as ReturnType<typeof readCloudWorkspaceRecord>
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetCloudProxyRefreshForTest()
  mockReadRecord.mockReturnValue(record())
})

afterEach(() => {
  _resetCloudProxyRefreshForTest()
})

describe('resolveCloudProxyTarget', () => {
  it('returns the stored deployment and token', () => {
    expect(resolveCloudProxyTarget()).toEqual({
      deploymentUrl: 'https://ws.example.com',
      token: 'deployment-token',
    })
  })

  it('has nothing to forward to without a record', () => {
    mockReadRecord.mockReturnValue(null)
    expect(resolveCloudProxyTarget()).toBeNull()
  })

  it('has nothing to forward to without a token', () => {
    mockReadRecord.mockReturnValue(record({ token: '' }))
    expect(resolveCloudProxyTarget()).toBeNull()
  })

  it('refuses a URL the deployment policy rejects', () => {
    mockReadRecord.mockReturnValue(record({ deploymentUrl: 'http://ws.example.com' }))
    expect(resolveCloudProxyTarget()).toBeNull()
  })

  it('normalizes away a trailing slash so paths do not double up', () => {
    mockReadRecord.mockReturnValue(record({ deploymentUrl: 'https://ws.example.com/' }))
    expect(resolveCloudProxyTarget()?.deploymentUrl).toBe('https://ws.example.com')
  })

  it('still offers a token the local clock believes is expired', () => {
    // The deployment decides whether its own token is good; a fast local clock
    // must not take a working session away from the user.
    mockReadRecord.mockReturnValue(
      record({ expiresAt: new Date(Date.now() - 3600_000).toISOString() }),
    )
    expect(resolveCloudProxyTarget()).not.toBeNull()
  })
})

describe('refreshCloudProxyTarget', () => {
  it('re-mints and returns the new target', async () => {
    mockGetCloudWorkspace.mockImplementation(async () => {
      mockReadRecord.mockReturnValue(record({ token: 'fresh-token' }))
      return status({ hasValidToken: true })
    })

    const target = await refreshCloudProxyTarget()

    expect(mockGetCloudWorkspace).toHaveBeenCalledWith({ forceTokenRefresh: true })
    expect(target?.token).toBe('fresh-token')
  })

  it('collapses a burst of concurrent refreshes into one mint', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mockGetCloudWorkspace.mockImplementation(async () => {
      await gate
      return status({ hasValidToken: true })
    })

    // A session expiring 401s every in-flight request at once; each one asks for
    // a refresh. They must not each mint a grant.
    const all = Promise.all([
      refreshCloudProxyTarget(),
      refreshCloudProxyTarget(),
      refreshCloudProxyTarget(),
    ])
    release()
    const results = await all

    expect(mockGetCloudWorkspace).toHaveBeenCalledTimes(1)
    expect(results.every((r) => r?.token === 'deployment-token')).toBe(true)
  })

  it('refuses to mint again inside the cooldown', async () => {
    mockGetCloudWorkspace.mockResolvedValue(status({ hasValidToken: true }))

    await refreshCloudProxyTarget()
    // A deployment that rejects even a fresh token would otherwise turn every
    // request into another round-trip to the platform.
    await refreshCloudProxyTarget()

    expect(mockGetCloudWorkspace).toHaveBeenCalledTimes(1)
  })

  it('hands the fresh token to a straggler that misses the single flight', async () => {
    mockGetCloudWorkspace.mockImplementation(async () => {
      mockReadRecord.mockReturnValue(record({ token: 'fresh-token' }))
      return status({ hasValidToken: true })
    })

    await refreshCloudProxyTarget()
    // The last 401s of the burst land just after the flight settles — too late
    // to join it, and there is a working token sitting right there.
    const straggler = await refreshCloudProxyTarget()

    expect(straggler?.token).toBe('fresh-token')
    expect(mockGetCloudWorkspace).toHaveBeenCalledTimes(1)
  })

  it('does not resurrect a token cleared while the cooldown was running', async () => {
    mockGetCloudWorkspace.mockImplementation(async () => {
      mockReadRecord.mockReturnValue(record({ token: 'fresh-token' }))
      return status({ hasValidToken: true })
    })

    await refreshCloudProxyTarget()
    // Account switch / disconnect between the two calls.
    mockReadRecord.mockReturnValue(null)

    await expect(refreshCloudProxyTarget()).resolves.toBeNull()
  })

  it('reports no target when the mint failed, stale record and all', async () => {
    // The service leaves the rejected token in the record on purpose, so the
    // record cannot be the signal — only the status can.
    mockGetCloudWorkspace.mockResolvedValue(status({ hasValidToken: false }))

    await expect(refreshCloudProxyTarget()).resolves.toBeNull()
    // …and the rejected token is still sitting there, resolvable. That is
    // precisely why the record cannot be the signal.
    expect(resolveCloudProxyTarget()?.token).toBe('deployment-token')
  })

  it('declines during the cooldown when the refresh itself failed', async () => {
    mockGetCloudWorkspace.mockResolvedValue(status({ hasValidToken: false }))

    await refreshCloudProxyTarget()
    // Replaying against a token we just watched be rejected only doubles the
    // traffic to the deployment.
    await expect(refreshCloudProxyTarget()).resolves.toBeNull()
    expect(mockGetCloudWorkspace).toHaveBeenCalledTimes(1)
  })

  it('reports no target — rather than failing — when the mint throws', async () => {
    mockGetCloudWorkspace.mockRejectedValue(new Error('platform down'))
    await expect(refreshCloudProxyTarget()).resolves.toBeNull()
  })
})
