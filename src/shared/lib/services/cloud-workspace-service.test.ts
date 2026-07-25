import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getCloudWorkspace } from './cloud-workspace-service'
import {
  exchangeGrantAtDeployment,
  fetchDeployments,
  requestDeploymentGrant,
} from '@shared/lib/platform-auth/cloud-workspace-client'
import {
  clearCloudWorkspaceRecord,
  readCloudWorkspaceRecord,
  writeCloudWorkspaceRecord,
} from '@shared/lib/platform-auth/cloud-workspace-record'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('@shared/lib/platform-auth/cloud-workspace-client', () => ({
  fetchDeployments: vi.fn(),
  requestDeploymentGrant: vi.fn(),
  exchangeGrantAtDeployment: vi.fn(),
}))
vi.mock('@shared/lib/platform-auth/cloud-workspace-record', () => ({
  readCloudWorkspaceRecord: vi.fn(),
  writeCloudWorkspaceRecord: vi.fn(),
  clearCloudWorkspaceRecord: vi.fn(),
  buildCloudWorkspaceTokenPreview: (t: string) => `${t.slice(0, 3)}…`,
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: vi.fn(),
}))

const mockFetchDeployments = vi.mocked(fetchDeployments)
const mockRequestGrant = vi.mocked(requestDeploymentGrant)
const mockExchange = vi.mocked(exchangeGrantAtDeployment)
const mockReadRecord = vi.mocked(readCloudWorkspaceRecord)
const mockWriteRecord = vi.mocked(writeCloudWorkspaceRecord)
const mockClearRecord = vi.mocked(clearCloudWorkspaceRecord)
const mockGetToken = vi.mocked(getPlatformAccessToken)

const DEPLOYED = {
  org_id: 'org_1',
  deployment_url: 'https://ws.example.com',
  authorization_server: 'https://ws.example.com',
  status: 'deployed',
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

describe('getCloudWorkspace', () => {
  const originalProcessType = (process as { type?: string }).type

  beforeEach(() => {
    vi.clearAllMocks()
    // Simulate the Electron main process (the only place this feature runs).
    ;(process as { type?: string }).type = 'browser'
    mockGetToken.mockReturnValue('plat_sa_key')
    mockReadRecord.mockReturnValue(null)
  })

  afterEach(() => {
    if (originalProcessType === undefined) {
      delete (process as { type?: string }).type
    } else {
      ;(process as { type?: string }).type = originalProcessType
    }
  })

  it('is unavailable and does nothing off the Electron main process', async () => {
    ;(process as { type?: string }).type = undefined
    const status = await getCloudWorkspace()
    expect(status).toEqual({
      available: false,
      found: false,
      deploymentUrl: null,
      orgId: null,
      hasValidToken: false,
    })
    expect(mockFetchDeployments).not.toHaveBeenCalled()
  })

  it('clears any stored record and reports unavailable when not connected', async () => {
    mockGetToken.mockReturnValue(null)
    const status = await getCloudWorkspace()
    expect(status.available).toBe(false)
    expect(mockClearRecord).toHaveBeenCalledOnce()
    expect(mockFetchDeployments).not.toHaveBeenCalled()
  })

  it('sends the raw token and, on discovery failure, stays available without wiping the token', async () => {
    mockFetchDeployments.mockRejectedValue(new Error('401'))
    const status = await getCloudWorkspace()
    expect(mockFetchDeployments).toHaveBeenCalledWith('plat_sa_key')
    expect(status).toMatchObject({ available: true, found: false, hasValidToken: false })
    // A transient discovery failure must not clear a still-valid stored token.
    expect(mockClearRecord).not.toHaveBeenCalled()
  })

  it('clears the record and reports not-found when there is no deployed workspace', async () => {
    mockFetchDeployments.mockResolvedValue([
      { ...DEPLOYED, status: 'deploying' },
      { ...DEPLOYED, deployment_url: '', status: 'deployed' },
    ])
    const status = await getCloudWorkspace()
    expect(status).toMatchObject({ found: false, deploymentUrl: null })
    expect(mockClearRecord).toHaveBeenCalledOnce()
    expect(mockRequestGrant).not.toHaveBeenCalled()
  })

  it('mints a grant and exchanges it when no token is stored, then persists it', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    mockRequestGrant.mockResolvedValue('grant.jwt')
    mockExchange.mockResolvedValue({ token: 'deploy_tok', expiresInSec: 7 * 24 * 3600 })

    const status = await getCloudWorkspace()

    expect(mockRequestGrant).toHaveBeenCalledWith('plat_sa_key', DEPLOYED.authorization_server)
    expect(mockExchange).toHaveBeenCalledWith(DEPLOYED.deployment_url, 'grant.jwt')
    expect(mockWriteRecord).toHaveBeenCalledOnce()
    const written = mockWriteRecord.mock.calls[0][0]
    expect(written).toMatchObject({
      deploymentUrl: DEPLOYED.deployment_url,
      orgId: DEPLOYED.org_id,
      token: 'deploy_tok',
    })
    expect(status).toMatchObject({ found: true, deploymentUrl: DEPLOYED.deployment_url, hasValidToken: true })
  })

  it('reuses a valid stored token for the same deployment without minting', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    mockReadRecord.mockReturnValue({
      deploymentUrl: DEPLOYED.deployment_url,
      orgId: DEPLOYED.org_id,
      token: 'existing',
      tokenPreview: 'exi…',
      expiresAt: isoIn(2 * 3600_000), // 2h out — comfortably valid
      updatedAt: isoIn(-3600_000),
    })

    const status = await getCloudWorkspace()

    expect(mockRequestGrant).not.toHaveBeenCalled()
    expect(mockExchange).not.toHaveBeenCalled()
    expect(mockWriteRecord).not.toHaveBeenCalled()
    expect(status).toMatchObject({ found: true, hasValidToken: true })
  })

  it('re-mints when the stored token is bound to a different deployment URL', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    mockReadRecord.mockReturnValue({
      deploymentUrl: 'https://old.example.com',
      orgId: DEPLOYED.org_id,
      token: 'stale',
      tokenPreview: 'sta…',
      expiresAt: isoIn(2 * 3600_000),
      updatedAt: isoIn(-3600_000),
    })
    mockRequestGrant.mockResolvedValue('grant.jwt')
    mockExchange.mockResolvedValue({ token: 'fresh', expiresInSec: 3600 })

    await getCloudWorkspace()

    expect(mockRequestGrant).toHaveBeenCalledOnce()
    expect(mockWriteRecord).toHaveBeenCalledOnce()
  })

  it('re-mints when the stored token is within the 1h refresh buffer of expiry', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    mockReadRecord.mockReturnValue({
      deploymentUrl: DEPLOYED.deployment_url,
      orgId: DEPLOYED.org_id,
      token: 'expiring',
      tokenPreview: 'exp…',
      expiresAt: isoIn(30 * 60_000), // 30 min out — inside the buffer
      updatedAt: isoIn(-3600_000),
    })
    mockRequestGrant.mockResolvedValue('grant.jwt')
    mockExchange.mockResolvedValue({ token: 'fresh', expiresInSec: 3600 })

    await getCloudWorkspace()

    expect(mockRequestGrant).toHaveBeenCalledOnce()
  })

  it('still reports the workspace as found when the grant/exchange fails', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    mockRequestGrant.mockRejectedValue(new Error('no exchange endpoint'))

    const status = await getCloudWorkspace()

    expect(status).toMatchObject({
      found: true,
      deploymentUrl: DEPLOYED.deployment_url,
      hasValidToken: false,
    })
    expect(mockWriteRecord).not.toHaveBeenCalled()
  })
})
