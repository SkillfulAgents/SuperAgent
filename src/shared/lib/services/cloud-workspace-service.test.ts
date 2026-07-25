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
import {
  getPlatformAccessToken,
  getPlatformAuthStatus,
} from '@shared/lib/services/platform-auth-service'
import { validateMcpDiscoveryUrl } from '@shared/lib/utils/url-safety'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
// SSRF/URL safety: stand in for the real validator — parses, and enforces the
// caller's loopback policy the same way the real one does — so the service's
// policy decision is exercised end to end here. Tests override to exercise
// other rejections.
vi.mock('@shared/lib/utils/url-safety', () => ({
  validateMcpDiscoveryUrl: vi.fn(async (u: string, policy?: { allowLocalhost?: boolean }) => {
    const parsed = new URL(u)
    if (['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) && !policy?.allowLocalhost) {
      throw new Error('URL must not point to a private or loopback address')
    }
    return parsed
  }),
  isLocalhostHost: (h: string) => ['127.0.0.1', 'localhost', '::1'].includes(h),
}))
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
  getPlatformAuthStatus: vi.fn(),
}))

const mockFetchDeployments = vi.mocked(fetchDeployments)
const mockRequestGrant = vi.mocked(requestDeploymentGrant)
const mockExchange = vi.mocked(exchangeGrantAtDeployment)
const mockReadRecord = vi.mocked(readCloudWorkspaceRecord)
const mockWriteRecord = vi.mocked(writeCloudWorkspaceRecord)
const mockClearRecord = vi.mocked(clearCloudWorkspaceRecord)
const mockGetToken = vi.mocked(getPlatformAccessToken)
const mockAuthStatus = vi.mocked(getPlatformAuthStatus)
const mockValidateUrl = vi.mocked(validateMcpDiscoveryUrl)

const DEPLOYED = {
  org_id: 'org_1',
  deployment_url: 'https://ws.example.com',
  authorization_server: 'https://ws.example.com',
  status: 'deployed',
}

const LOOPBACK = {
  org_id: 'org_1',
  deployment_url: 'http://127.0.0.1:8899',
  authorization_server: 'http://127.0.0.1:8899',
  status: 'deployed',
}

const PRINCIPAL = { userId: 'usr_1', memberId: 'sub_1' }

function connectedAs(principal: { userId: string | null; memberId: string | null }) {
  return { connected: true, ...principal } as unknown as ReturnType<typeof getPlatformAuthStatus>
}

const DISCONNECTED = {
  connected: false,
  userId: null,
  memberId: null,
} as unknown as ReturnType<typeof getPlatformAuthStatus>

function storedRecord(overrides: Record<string, unknown> = {}) {
  return {
    deploymentUrl: DEPLOYED.deployment_url,
    orgId: DEPLOYED.org_id,
    token: 'existing',
    tokenPreview: 'exi…',
    expiresAt: isoIn(2 * 3600_000), // 2h out — comfortably valid
    updatedAt: isoIn(-3600_000),
    userId: PRINCIPAL.userId,
    memberId: PRINCIPAL.memberId,
    ...overrides,
  } as ReturnType<typeof readCloudWorkspaceRecord>
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

describe('getCloudWorkspace', () => {
  const originalProcessType = (process as { type?: string }).type
  const originalIsPackaged = process.env.SUPERAGENT_IS_PACKAGED
  const originalE2eMock = process.env.E2E_MOCK

  beforeEach(() => {
    vi.clearAllMocks()
    // Simulate the Electron main process (the only place this feature runs).
    ;(process as { type?: string }).type = 'browser'
    // …and a shipped build by default. Loopback deployment targets must be
    // refused in this configuration.
    process.env.SUPERAGENT_IS_PACKAGED = '1'
    delete process.env.E2E_MOCK
    mockGetToken.mockReturnValue('plat_sa_key')
    mockAuthStatus.mockReturnValue(connectedAs(PRINCIPAL))
    mockReadRecord.mockReturnValue(null)
  })

  afterEach(() => {
    if (originalProcessType === undefined) {
      delete (process as { type?: string }).type
    } else {
      ;(process as { type?: string }).type = originalProcessType
    }
    if (originalIsPackaged === undefined) delete process.env.SUPERAGENT_IS_PACKAGED
    else process.env.SUPERAGENT_IS_PACKAGED = originalIsPackaged
    if (originalE2eMock === undefined) delete process.env.E2E_MOCK
    else process.env.E2E_MOCK = originalE2eMock
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

  it('drops the entry (never mints) when deployment_url != authorization_server', async () => {
    mockFetchDeployments.mockResolvedValue([
      { ...DEPLOYED, authorization_server: 'https://other.example.com' },
    ])
    const status = await getCloudWorkspace()
    expect(status).toMatchObject({ available: true, found: false, deploymentUrl: null })
    expect(mockValidateUrl).not.toHaveBeenCalled() // string mismatch short-circuits
    expect(mockRequestGrant).not.toHaveBeenCalled()
    expect(mockClearRecord).toHaveBeenCalled()
  })

  it('drops the entry (never mints) when the URL fails the SSRF/DNS check', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    mockValidateUrl.mockRejectedValueOnce(new Error('private address'))
    const status = await getCloudWorkspace()
    expect(status).toMatchObject({ available: true, found: false, deploymentUrl: null })
    expect(mockRequestGrant).not.toHaveBeenCalled()
    expect(mockClearRecord).toHaveBeenCalled()
  })

  it('drops the entry when the URL is non-HTTPS and non-loopback', async () => {
    mockFetchDeployments.mockResolvedValue([
      { ...DEPLOYED, deployment_url: 'http://ws.example.com', authorization_server: 'http://ws.example.com' },
    ])
    mockValidateUrl.mockResolvedValueOnce(new URL('http://ws.example.com'))
    const status = await getCloudWorkspace()
    expect(status).toMatchObject({ available: true, found: false })
    expect(mockRequestGrant).not.toHaveBeenCalled()
  })

  it('refuses a loopback deployment target in a shipped build', async () => {
    // The platform-supplied URL points at the user's own machine. A packaged
    // build must never send it a grant, even though Electron's default MCP
    // localhost exception would otherwise allow it.
    mockFetchDeployments.mockResolvedValue([LOOPBACK])
    mockRequestGrant.mockResolvedValue('grant.jwt')

    const status = await getCloudWorkspace()

    expect(mockValidateUrl).toHaveBeenCalledWith(LOOPBACK.deployment_url, { allowLocalhost: false })
    expect(status).toMatchObject({ available: true, found: false, deploymentUrl: null })
    expect(mockRequestGrant).not.toHaveBeenCalled()
    expect(mockExchange).not.toHaveBeenCalled()
  })

  it('refuses a loopback deployment target when the build mode is unknown', async () => {
    // Fail closed: absent an explicit "unpackaged" signal, assume shipped.
    delete process.env.SUPERAGENT_IS_PACKAGED
    mockFetchDeployments.mockResolvedValue([LOOPBACK])

    const status = await getCloudWorkspace()

    expect(status).toMatchObject({ found: false })
    expect(mockRequestGrant).not.toHaveBeenCalled()
  })

  it('allows a loopback deployment when running unpackaged (local dev stack)', async () => {
    process.env.SUPERAGENT_IS_PACKAGED = '0'
    mockFetchDeployments.mockResolvedValue([LOOPBACK])
    mockRequestGrant.mockResolvedValue('grant.jwt')
    mockExchange.mockResolvedValue({ token: 'tok', expiresInSec: 3600 })

    const status = await getCloudWorkspace()

    expect(status).toMatchObject({ found: true, hasValidToken: true })
    expect(mockExchange).toHaveBeenCalledWith(LOOPBACK.deployment_url, 'grant.jwt', {
      allowLocalhost: true,
    })
  })

  it('mints a grant and exchanges it when no token is stored, then persists it', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    mockRequestGrant.mockResolvedValue('grant.jwt')
    mockExchange.mockResolvedValue({ token: 'deploy_tok', expiresInSec: 7 * 24 * 3600 })

    const status = await getCloudWorkspace()

    expect(mockRequestGrant).toHaveBeenCalledWith('plat_sa_key', DEPLOYED.authorization_server)
    // The credential-bearing call goes out with an explicit host policy.
    expect(mockExchange).toHaveBeenCalledWith(DEPLOYED.deployment_url, 'grant.jwt', {
      allowLocalhost: false,
    })
    expect(mockWriteRecord).toHaveBeenCalledOnce()
    const written = mockWriteRecord.mock.calls[0][0]
    expect(written).toMatchObject({
      deploymentUrl: DEPLOYED.deployment_url,
      orgId: DEPLOYED.org_id,
      token: 'deploy_tok',
      userId: PRINCIPAL.userId,
      memberId: PRINCIPAL.memberId,
    })
    expect(status).toMatchObject({ found: true, deploymentUrl: DEPLOYED.deployment_url, hasValidToken: true })
  })

  it('reuses a valid stored token for the same deployment without minting', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    mockReadRecord.mockReturnValue(storedRecord())

    const status = await getCloudWorkspace()

    expect(mockRequestGrant).not.toHaveBeenCalled()
    expect(mockExchange).not.toHaveBeenCalled()
    expect(mockWriteRecord).not.toHaveBeenCalled()
    expect(status).toMatchObject({ found: true, hasValidToken: true })
  })

  it('re-mints when the stored token is bound to a different deployment URL', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    mockReadRecord.mockReturnValue(storedRecord({ deploymentUrl: 'https://old.example.com' }))
    mockRequestGrant.mockResolvedValue('grant.jwt')
    mockExchange.mockResolvedValue({ token: 'fresh', expiresInSec: 3600 })

    await getCloudWorkspace()

    expect(mockRequestGrant).toHaveBeenCalledOnce()
    expect(mockWriteRecord).toHaveBeenCalledOnce()
  })

  it('re-mints when the stored token is within the 1h refresh buffer of expiry', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    // 30 min out — inside the buffer.
    mockReadRecord.mockReturnValue(storedRecord({ expiresAt: isoIn(30 * 60_000) }))
    mockRequestGrant.mockResolvedValue('grant.jwt')
    mockExchange.mockResolvedValue({ token: 'fresh', expiresInSec: 3600 })

    await getCloudWorkspace()

    expect(mockRequestGrant).toHaveBeenCalledOnce()
  })

  it('re-mints rather than reusing a token minted for another principal', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    // Same org, same deployment, unexpired — but a different member.
    mockReadRecord.mockReturnValue(storedRecord({ userId: 'usr_other', memberId: 'sub_other' }))
    mockRequestGrant.mockResolvedValue('grant.jwt')
    mockExchange.mockResolvedValue({ token: 'fresh', expiresInSec: 3600 })

    await getCloudWorkspace()

    expect(mockRequestGrant).toHaveBeenCalledOnce()
    expect(mockWriteRecord.mock.calls[0][0]).toMatchObject({
      token: 'fresh',
      userId: PRINCIPAL.userId,
      memberId: PRINCIPAL.memberId,
    })
  })

  it('re-mints rather than reusing a legacy record with no principal', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    mockReadRecord.mockReturnValue(storedRecord({ userId: null, memberId: null }))
    mockRequestGrant.mockResolvedValue('grant.jwt')
    mockExchange.mockResolvedValue({ token: 'fresh', expiresInSec: 3600 })

    await getCloudWorkspace()

    expect(mockRequestGrant).toHaveBeenCalledOnce()
  })

  it('does not persist a token when the account disconnected mid-flight', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    mockRequestGrant.mockResolvedValue('grant.jwt')
    mockExchange.mockResolvedValue({ token: 'fresh', expiresInSec: 3600 })
    // Connected when the cycle starts; disconnected by the time the grant
    // round-trip returns — the clear already ran, so writing would resurrect it.
    mockAuthStatus.mockReturnValueOnce(connectedAs(PRINCIPAL)).mockReturnValue(DISCONNECTED)

    const status = await getCloudWorkspace()

    expect(mockWriteRecord).not.toHaveBeenCalled()
    expect(status).toMatchObject({ found: true, hasValidToken: false })
  })

  it('does not persist a token when the account switched mid-flight', async () => {
    mockFetchDeployments.mockResolvedValue([DEPLOYED])
    mockRequestGrant.mockResolvedValue('grant.jwt')
    mockExchange.mockResolvedValue({ token: 'fresh', expiresInSec: 3600 })
    mockAuthStatus
      .mockReturnValueOnce(connectedAs(PRINCIPAL))
      .mockReturnValue(connectedAs({ userId: 'usr_2', memberId: 'sub_2' }))

    const status = await getCloudWorkspace()

    expect(mockWriteRecord).not.toHaveBeenCalled()
    expect(status).toMatchObject({ hasValidToken: false })
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
