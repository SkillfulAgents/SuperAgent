import { z } from 'zod'
import { LINEAR_SCOPES, linearTokensSchema, type LinearTokens, type LinearIdentity } from './config'
import { getLinearConfig, updateLinearConfig, revokeLinearAuthorization } from './store'

export class LinearAuthorizationError extends Error {}
export class LinearAccessError extends Error {}
export class LinearNotFoundError extends LinearAccessError {}
export class LinearServerError extends Error {}
const tokenResponseSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  expires_in: z.number().positive(), scope: z.string(),
})
export async function exchangeLinearToken(params: Record<string, string>): Promise<LinearTokens> {
  const response = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params), signal: AbortSignal.timeout(15000),
  })
  // OAuth error bodies can contain credentials. Keep them out of logs and responses.
  if (!response.ok) {
    const message = `Linear authorization failed (${response.status}). Reconnect the app.`
    throw response.status === 400 || response.status === 401 ? new LinearAuthorizationError(message) : new Error(message)
  }
  const token = tokenResponseSchema.parse(await response.json())
  const scopes = token.scope.split(/[ ,]+/)
  if (LINEAR_SCOPES.some(scope => !scopes.includes(scope))) throw new Error('Linear did not grant all required agent permissions')
  return linearTokensSchema.parse({ accessToken: token.access_token, refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000, scope: token.scope })
}
type Authorization = { tokens: LinearTokens; authorizationVersion: string | undefined }
const refreshes = new Map<string, Promise<Authorization>>()
async function tokenFor(id: string): Promise<Authorization> {
  const config = await getLinearConfig(id)
  if (config.authorizationError || config.authorizationPending || !config.tokens || !config.clientId || !config.clientSecret) throw new Error('Linear is not authorized')
  if (config.tokens.expiresAt > Date.now() + 60000) return { tokens: config.tokens, authorizationVersion: config.authorizationVersion }
  const existing = refreshes.get(id)
  if (existing) return existing
  const oldRefresh = config.tokens.refreshToken
  const refresh = exchangeLinearToken({ grant_type: 'refresh_token', refresh_token: oldRefresh,
    client_id: config.clientId, client_secret: config.clientSecret }).then(async tokens => {
    await updateLinearConfig(id, latest => {
      if (latest.tokens?.refreshToken !== oldRefresh || latest.authorizationVersion !== config.authorizationVersion) throw new Error('Linear authorization changed during renewal')
      return { ...latest, tokens }
    })
    return { tokens, authorizationVersion: config.authorizationVersion }
  }).catch(async error => {
    if (error instanceof LinearAuthorizationError) {
      await revokeLinearAuthorization(id, { refreshToken: oldRefresh, authorizationVersion: config.authorizationVersion })
    }
    throw error
  }).finally(() => { if (refreshes.get(id) === refresh) refreshes.delete(id) })
  refreshes.set(id, refresh)
  return refresh
}

export class LinearClient {
  constructor(private readonly integrationId?: string, private readonly accessToken?: string, private readonly assertActive?: () => void) {}

  withGuard(assertActive: () => void): LinearClient {
    return new LinearClient(this.integrationId, this.accessToken, () => { this.assertActive?.(); assertActive() })
  }

  async authorization(): Promise<{ accessToken: string; expiresAt: number }> {
    if (this.integrationId) return (await tokenFor(this.integrationId)).tokens
    if (!this.accessToken) throw new Error('Linear is not authorized')
    return { accessToken: this.accessToken, expiresAt: Date.now() + 3600000 }
  }

  async request<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const authorization = this.integrationId ? await tokenFor(this.integrationId) : undefined
    const token = authorization?.tokens.accessToken ?? this.accessToken
    if (!token) throw new Error('Linear is not authorized')
    this.assertActive?.()
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    })
    if (response.status === 401 && this.integrationId) {
      await revokeLinearAuthorization(this.integrationId, { accessToken: token, authorizationVersion: authorization?.authorizationVersion })
    }
    if (response.status === 403 || response.status === 404) throw new LinearAccessError('Linear issue is no longer accessible')
    if (response.status >= 500) throw new LinearServerError(`Linear request failed (${response.status})`)
    if (!response.ok) throw new Error(`Linear request failed (${response.status})`)
    const result = z.object({ data: z.unknown().optional(), errors: z.array(z.object({ message: z.string().optional(), extensions: z.object({ code: z.string().optional() }).passthrough().optional() }).passthrough()).optional() }).parse(await response.json())
    if (result.errors?.some(error => ['NOT_FOUND', 'ENTITY_NOT_FOUND'].includes(error.extensions?.code ?? '') || (error.extensions?.code === 'INPUT_ERROR' && error.message?.startsWith('Entity not found:')))) throw new LinearNotFoundError('Linear entity was not found')
    if (result.errors?.some(error => error.extensions?.code === 'FORBIDDEN')) throw new LinearAccessError('Linear operation is not permitted')
    if (result.errors?.length) throw new Error('Linear could not complete the operation. Check app access and the requested fields.')
    return schema.parse(result.data)
  }

  async identity(): Promise<LinearIdentity> {
    const { viewer } = await this.request(`query { viewer { id name displayName app avatarUrl organization { id name } } }`, {},
      z.object({ viewer: z.object({ id: z.string(), name: z.string(), displayName: z.string(), app: z.boolean(),
        avatarUrl: z.string().nullable(), organization: z.object({ id: z.string(), name: z.string() }) }) }))
    if (!viewer.app) throw new Error('Authorize a Linear app identity, not a personal account')
    return { workspaceId: viewer.organization.id, workspaceName: viewer.organization.name,
      appUserId: viewer.id, appName: viewer.displayName || viewer.name, avatarUrl: viewer.avatarUrl }
  }
}

export async function revokeLinearToken(token: string): Promise<void> {
  const response = await fetch('https://api.linear.app/oauth/revoke', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, token_type_hint: 'refresh_token' }), signal: AbortSignal.timeout(15000),
  })
  if (!response.ok && response.status !== 400 && response.status !== 401) throw new Error(`Could not revoke Linear authorization (${response.status})`)
}
