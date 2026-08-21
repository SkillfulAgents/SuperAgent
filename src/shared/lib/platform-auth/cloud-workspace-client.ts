import {
  getPlatformAuthIssuerUrl,
  getPlatformProxyBaseUrl,
} from '@shared/lib/platform-auth/config'
import { mcpSafeFetch } from '@shared/lib/mcp/mcp-safe-fetch'
import type { DiscoveryHostPolicy } from '@shared/lib/utils/url-safety'
import {
  DEPLOYMENT_ASSERTION_PATH,
  DEPLOYMENT_TOKEN_EXCHANGE_PATH,
  DeploymentDiscoveryResponseSchema,
  DeploymentGrantResponseSchema,
  DeploymentTokenResponseSchema,
  JWT_BEARER_GRANT_TYPE,
  ME_DEPLOYMENTS_PATH,
  REQUESTED_TOKEN_TYPE_JWT,
  SUBJECT_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  type DeploymentDiscoveryEntry,
} from '@shared/lib/platform-auth/cloud-workspace-schema'

/**
 * Client for the cloud-workspace discovery + grant chain.
 *
 * The two calls to *configured* platform hosts (discovery, grant) use a direct,
 * controlled `fetch` — not the shared attribution-aware `fetchPlatformJson`:
 * the discovery endpoint rejects org-runtime JWTs and any `token::memberId`
 * attribution suffix, so we must present the raw member-bound token verbatim.
 * The caller (service / launch hook) runs outside any attribution scope, and in
 * the Electron desktop context the platform fetch interceptor isn't installed.
 *
 * The third call targets a *remotely supplied* URL and carries the grant, so it
 * uses the pinned, manual-redirect `mcpSafeFetch` — see below.
 */

/**
 * Every failure in the chain surfaces as one of these, with the underlying
 * network/parse error attached as `cause` — Sentry follows the cause chain, so
 * the caller reports once and still gets the root cause. Callers must not
 * capture separately: this runs on a 30-minute maintenance poll, and
 * double-reporting a persistent condition is how you flood an error budget.
 */
export class CloudWorkspaceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'CloudWorkspaceError'
  }
}

function formInit(form: URLSearchParams): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  }
}

/** POST to a *configured* (trusted) platform host. */
async function postForm(url: string, form: URLSearchParams): Promise<Response> {
  return fetch(url, formInit(form))
}

/**
 * Discover the caller's cloud deployments via `GET /v1/me/deployments`. Returns
 * every entry (any status); the service filters to `deployed`.
 */
export async function fetchDeployments(token: string): Promise<DeploymentDiscoveryEntry[]> {
  const proxyBase = getPlatformProxyBaseUrl()
  if (!proxyBase) throw new CloudWorkspaceError('Platform proxy is not configured.', 500)

  let res: Response
  try {
    res = await fetch(`${proxyBase}${ME_DEPLOYMENTS_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (error) {
    throw new CloudWorkspaceError('Could not reach the platform.', 502, { cause: error })
  }
  if (!res.ok) {
    throw new CloudWorkspaceError(`Deployment discovery failed (${res.status}).`, res.status)
  }
  const data = await res.json().catch(() => null)
  const parsed = DeploymentDiscoveryResponseSchema.safeParse(data)
  if (!parsed.success) {
    throw new CloudWorkspaceError('The platform returned an unexpected response.', 502, {
      cause: parsed.error,
    })
  }
  return parsed.data
}

/**
 * Mint a short-lived (single-use) RFC 8693 deployment grant for `resourceUrl`
 * (the entry's `authorization_server`) from the platform auth issuer.
 */
export async function requestDeploymentGrant(token: string, resourceUrl: string): Promise<string> {
  const issuer = getPlatformAuthIssuerUrl()
  if (!issuer) throw new CloudWorkspaceError('Platform auth issuer is not configured.', 500)

  const form = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: token,
    subject_token_type: SUBJECT_TOKEN_TYPE,
    requested_token_type: REQUESTED_TOKEN_TYPE_JWT,
    resource: resourceUrl,
  })

  let res: Response
  try {
    res = await postForm(`${issuer}${DEPLOYMENT_ASSERTION_PATH}`, form)
  } catch (error) {
    throw new CloudWorkspaceError('Could not reach the platform auth server.', 502, {
      cause: error,
    })
  }
  if (!res.ok) {
    throw new CloudWorkspaceError(`Grant request failed (${res.status}).`, res.status)
  }
  const data = await res.json().catch(() => null)
  const parsed = DeploymentGrantResponseSchema.safeParse(data)
  if (!parsed.success) {
    throw new CloudWorkspaceError('The platform returned an unexpected grant response.', 502, {
      cause: parsed.error,
    })
  }
  return parsed.data.access_token
}

/**
 * Exchange the platform grant at the target deployment's own RFC 7523 endpoint
 * for a deployment session token. Returns the token and its lifetime (seconds).
 *
 * This is the one call in the chain that carries a credential to a *remotely
 * supplied* host, so it goes through `mcpSafeFetch` rather than bare `fetch`:
 * the socket is pinned to the vetted, freshly resolved address (closing the
 * DNS-rebind window between validation and connect) and redirects are followed
 * manually, so a 307/308 can't replay the assertion body onto another origin.
 * `policy` must carry the caller's explicit loopback decision.
 */
export async function exchangeGrantAtDeployment(
  deploymentUrl: string,
  grant: string,
  policy: DiscoveryHostPolicy,
): Promise<{ token: string; expiresInSec: number; setCookies: string[] }> {
  const base = deploymentUrl.replace(/\/+$/, '')
  const form = new URLSearchParams({
    grant_type: JWT_BEARER_GRANT_TYPE,
    assertion: grant,
  })

  let res: Response
  try {
    res = await mcpSafeFetch(`${base}${DEPLOYMENT_TOKEN_EXCHANGE_PATH}`, formInit(form), policy)
  } catch (error) {
    throw new CloudWorkspaceError('Could not reach the cloud deployment.', 502, { cause: error })
  }
  if (!res.ok) {
    // Older deployments without the token-exchange endpoint 404/400 here — the
    // service treats any failure as "no token" and degrades gracefully.
    throw new CloudWorkspaceError(`Deployment token exchange failed (${res.status}).`, res.status)
  }
  const data = await res.json().catch(() => null)
  const parsed = DeploymentTokenResponseSchema.safeParse(data)
  if (!parsed.success) {
    throw new CloudWorkspaceError('The deployment returned an unexpected token response.', 502, {
      cause: parsed.error,
    })
  }
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const setCookies = typeof getSetCookie === 'function' ? getSetCookie.call(res.headers) : []
  return {
    token: parsed.data.access_token,
    expiresInSec: parsed.data.expires_in,
    setCookies: Array.isArray(setCookies) ? setCookies.filter((line) => typeof line === 'string') : [],
  }
}
