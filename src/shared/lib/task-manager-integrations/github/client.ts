import { sign } from 'node:crypto'
import type { z } from 'zod'
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
export async function githubRequest<T>(path: string, schema: z.ZodType<T>, token?: string, body?: unknown): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid GitHub API path')
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) { await response.body?.cancel(); throw new GitHubApiError(response.status) }
  return schema.parse(await response.json())
}

interface Token { value: string; expiresAt: number; version?: string }
const tokens = new Map<string, Token>()
const refreshing = new Map<string, Promise<Token>>()
export function forgetGitHubToken(id: string): void { tokens.delete(id) }

/** Credentials never leave the host. The same short-lived token powers REST and MCP. */
export class GitHubClient {
  constructor(readonly integrationId: string) {}
  async authorization(expectedVersion?: { version: string | undefined; agentSlug: string }): Promise<string> {
    const { row, config } = await readGitHubIntegration(this.integrationId)
    if (expectedVersion && (config.authorizationVersion !== expectedVersion.version || row.agentSlug !== expectedVersion.agentSlug)) throw new Error('GitHub authorization changed')
    if (!['active', 'error'].includes(row.status) || config.pending || config.authorizationError || !config.app || !config.installation) throw new Error('GitHub integration is not active')
    let token = tokens.get(row.id)
    if (!token || token.version !== config.authorizationVersion || token.expiresAt < Date.now() + 60000) {
      const key = `${row.id}:${config.authorizationVersion}`
      let request = refreshing.get(key)
      if (!request) {
        request = githubRequest(`/app/installations/${config.installation.id}/access_tokens`, githubTokenSchema, githubAppJwt(config.app), {})
          .then(result => ({ value: result.token, expiresAt: Date.parse(result.expires_at), version: config.authorizationVersion }))
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
