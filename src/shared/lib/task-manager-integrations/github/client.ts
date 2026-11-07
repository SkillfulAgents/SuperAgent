import { sign } from 'node:crypto'
import type { z } from 'zod'
import { defineLease } from '../../app-state'
import { githubTokenSchema } from './api-schema'
import type { GitHubConfig } from './config-schema'
import { readGitHubIntegration, revokeGitHubAuthorization } from './store'

const API = 'https://api.github.com'
export class GitHubApiError extends Error {
  constructor(readonly status: number) { super(`GitHub request failed (${status})`); this.name = 'GitHubApiError' }
}
export function githubAppJwt(app: NonNullable<GitHubConfig['app']>): string {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.id })).toString('base64url')}`
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), app.privateKey).toString('base64url')}`
}
const REQUEST_TIMEOUT_MS = 20_000
export async function githubRequest<T>(path: string, schema: z.ZodType<T>, token?: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid GitHub API path')
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) { await response.body?.cancel(); throw new GitHubApiError(response.status) }
  return schema.parse(await response.json())
}

interface Token { value: string; expiresAt: number; version?: string }
// Process-local: each process mints and caches its own installation token.
const tokens = new Map<string, Token>()
// Same-process callers share one mint instead of each asking AppState.
const refreshing = new Map<string, Promise<Token>>()
export function forgetGitHubToken(id: string): void { tokens.delete(id) }

/**
 * One process mints an installation token for an authorization at a time:
 * `claim:github-token/{integrationId}:{authorizationVersion}`. A mint is sent
 * only while the claim is held for the request's whole 20 s timeout, and the
 * claim is renewed while it runs. The token is not shared: a process that
 * waited for the claim then mints its own.
 */
const mintClaims = defineLease({ name: 'claim:github-token', ttlMs: 30_000 })
/** Long enough for a dead holder's claim to lapse and one more mint to run. */
const MINT_WAIT_MS = mintClaims.ttlMs + REQUEST_TIMEOUT_MS
const REFRESH_BEFORE_EXPIRY_MS = 60_000

async function mintInstallationToken(integrationId: string, config: GitHubConfig, installationId: number, app: NonNullable<GitHubConfig['app']>): Promise<Token> {
  const claim = mintClaims.key(integrationId, config.authorizationVersion ?? 'unversioned')
  // Waits out another process's mint, then mints this process's own token.
  const turn = await mintClaims.acquireWhenFree(claim, { timeoutMs: MINT_WAIT_MS })
  if (!turn.acquired) return turn.result
  return mintClaims.hold(turn.lease, async holding => {
    // Held for the request's whole timeout, by this process's clock, with
    // nothing awaited before the send: the mint cannot outlive the claim.
    await holding.confirm({ minRemainingMs: REQUEST_TIMEOUT_MS })
    const result = await githubRequest(`/app/installations/${installationId}/access_tokens`, githubTokenSchema, githubAppJwt(app), {}, holding.signal)
    return { value: result.token, expiresAt: Date.parse(result.expires_at), version: config.authorizationVersion }
  })
}

/** Credentials never leave the host. The same short-lived token powers REST and MCP. */
export class GitHubClient {
  constructor(readonly integrationId: string) {}
  async authorization(expectedVersion?: { version: string | undefined; agentSlug: string }): Promise<string> {
    const { row, config } = await readGitHubIntegration(this.integrationId)
    if (expectedVersion && (config.authorizationVersion !== expectedVersion.version || row.agentSlug !== expectedVersion.agentSlug)) throw new Error('GitHub authorization changed')
    if (!['active', 'error'].includes(row.status) || config.pending || config.authorizationError || !config.app || !config.installation) throw new Error('GitHub integration is not active')
    let token = tokens.get(row.id)
    if (!token || token.version !== config.authorizationVersion || token.expiresAt < Date.now() + REFRESH_BEFORE_EXPIRY_MS) {
      const key = `${row.id}:${config.authorizationVersion}`
      let request = refreshing.get(key)
      if (!request) {
        request = mintInstallationToken(row.id, config, config.installation.id, config.app)
          .catch(async (error: unknown) => {
            if (error instanceof GitHubApiError && [401, 404].includes(error.status)) await revokeGitHubAuthorization(row.id, config.authorizationVersion)
            throw error
          }).finally(() => { refreshing.delete(key) })
        refreshing.set(key, request)
      }
      token = await request
      // Pausing, deleting or replacing authorization during renewal must close access.
      const latest = await readGitHubIntegration(row.id)
      if (!['active', 'error'].includes(latest.row.status) || latest.config.pending || latest.config.authorizationError || latest.config.authorizationVersion !== config.authorizationVersion) throw new Error('GitHub integration authorization changed')
      tokens.set(row.id, token)
    }
    return token.value
  }
  async request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const token = await this.authorization()
    try { return await githubRequest(path, schema, token, body) }
    catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 401) throw error
      forgetGitHubToken(this.integrationId)
      return githubRequest(path, schema, await this.authorization(), body)
    }
  }
}
