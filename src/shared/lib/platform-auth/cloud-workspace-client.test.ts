import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CloudWorkspaceError,
  exchangeGrantAtDeployment,
  fetchDeployments,
  requestDeploymentGrant,
} from './cloud-workspace-client'
import { getPlatformAuthIssuerUrl, getPlatformProxyBaseUrl } from './config'
import { mcpSafeFetch } from '@shared/lib/mcp/mcp-safe-fetch'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('./config', () => ({
  getPlatformProxyBaseUrl: vi.fn(),
  getPlatformAuthIssuerUrl: vi.fn(),
}))
vi.mock('@shared/lib/mcp/mcp-safe-fetch', () => ({ mcpSafeFetch: vi.fn() }))

const mockProxyBase = vi.mocked(getPlatformProxyBaseUrl)
const mockIssuer = vi.mocked(getPlatformAuthIssuerUrl)
const mockSafeFetch = vi.mocked(mcpSafeFetch)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  mockProxyBase.mockReturnValue('https://proxy.example.com')
  mockIssuer.mockReturnValue('https://auth.example.com')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchDeployments', () => {
  it('GETs discovery with the raw bearer (no attribution suffix) and returns the array', async () => {
    const entries = [
      {
        org_id: 'org_1',
        deployment_url: 'https://ws.example.com',
        authorization_server: 'https://ws.example.com',
        status: 'deployed',
      },
    ]
    fetchMock.mockResolvedValue(jsonResponse(entries))

    const result = await fetchDeployments('plat_sa_key')

    expect(fetchMock).toHaveBeenCalledWith('https://proxy.example.com/v1/me/deployments', {
      headers: { Authorization: 'Bearer plat_sa_key' },
    })
    expect(result).toEqual(entries)
  })

  it('throws CloudWorkspaceError carrying the status on a non-2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: {} }, 401))
    await expect(fetchDeployments('t')).rejects.toMatchObject({
      name: 'CloudWorkspaceError',
      status: 401,
    })
  })

  it('rejects a malformed discovery body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ not: 'an array' }))
    await expect(fetchDeployments('t')).rejects.toBeInstanceOf(CloudWorkspaceError)
  })
})

describe('requestDeploymentGrant', () => {
  it('POSTs the RFC 8693 form to the issuer and returns the grant token', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'grant.jwt',
        issued_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        token_type: 'N_A',
        expires_in: 120,
      }),
    )

    const token = await requestDeploymentGrant('subject_tok', 'https://ws.example.com')

    expect(token).toBe('grant.jwt')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://auth.example.com/token/deployment-assertion')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' })
    const form = new URLSearchParams(init.body as string)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
    expect(form.get('subject_token')).toBe('subject_tok')
    expect(form.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token')
    expect(form.get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:jwt')
    expect(form.get('resource')).toBe('https://ws.example.com')
  })

  it('errors when the auth issuer is unconfigured', async () => {
    mockIssuer.mockReturnValue('')
    await expect(requestDeploymentGrant('t', 'https://ws.example.com')).rejects.toBeInstanceOf(
      CloudWorkspaceError,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('exchangeGrantAtDeployment', () => {
  it('POSTs the RFC 7523 jwt-bearer form to the deployment (trailing slash stripped)', async () => {
    mockSafeFetch.mockResolvedValue(
      jsonResponse({ access_token: 'deploy_tok', token_type: 'Bearer', expires_in: 604800 }),
    )

    const result = await exchangeGrantAtDeployment('https://ws.example.com/', 'grant.jwt', {
      allowLocalhost: false,
    })

    expect(result).toEqual({ token: 'deploy_tok', expiresInSec: 604800 })
    const [url, init, policy] = mockSafeFetch.mock.calls[0]
    expect(url).toBe('https://ws.example.com/api/auth/token/exchange')
    const form = new URLSearchParams(init?.body as string)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(form.get('assertion')).toBe('grant.jwt')
    expect(policy).toEqual({ allowLocalhost: false })
  })

  it('sends the grant through the pinned, manual-redirect fetch — never bare fetch', async () => {
    // The assertion goes to a remotely supplied host: bare `fetch` would
    // re-resolve (DNS rebind) and auto-follow a 307/308 onto another origin.
    mockSafeFetch.mockResolvedValue(
      jsonResponse({ access_token: 'deploy_tok', token_type: 'Bearer', expires_in: 60 }),
    )

    await exchangeGrantAtDeployment('https://ws.example.com', 'grant.jwt', {
      allowLocalhost: false,
    })

    expect(mockSafeFetch).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws on an exchange failure (e.g. a deployment without the endpoint)', async () => {
    mockSafeFetch.mockResolvedValue(jsonResponse({ error: 'not_found' }, 404))
    await expect(
      exchangeGrantAtDeployment('https://ws.example.com', 'g', { allowLocalhost: false }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('throws when the safe fetch refuses the target (SSRF policy)', async () => {
    mockSafeFetch.mockRejectedValue(new Error('URL must not point to a private or loopback address'))
    await expect(
      exchangeGrantAtDeployment('http://127.0.0.1:8899', 'g', { allowLocalhost: false }),
    ).rejects.toBeInstanceOf(CloudWorkspaceError)
  })
})
