import { z } from 'zod'
import { appState, defineLease, defineNamespace, digestKeyPart, type LeaseHolding, type Revision } from '../../app-state'
import { LINEAR_SCOPES, linearTokensSchema, type LinearConfig, type LinearTokens, type LinearIdentity } from './config'
import { getLinearConfig, updateLinearConfig, revokeLinearAuthorization } from './store'

export class LinearAuthorizationError extends Error {}
export class LinearAccessError extends Error {}
export class LinearNotFoundError extends LinearAccessError {}
export class LinearServerError extends Error {}
/**
 * Linear refused a refresh token that an earlier exchange spent without a
 * recorded outcome. Transient: the authorization stays while that exchange's
 * result can still be saved (see `exchangeUnderClaim`).
 */
export class LinearRenewalPendingError extends Error {}
const tokenResponseSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  expires_in: z.number().positive(), scope: z.string(),
})
const EXCHANGE_TIMEOUT_MS = 15_000
export async function exchangeLinearToken(params: Record<string, string>): Promise<LinearTokens> {
  const response = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params), signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
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
/** Tokens are renewed once less than this is left of them. */
const REFRESH_BEFORE_EXPIRY_MS = 60_000
const changedDuringRenewal = () => new Error('Linear authorization changed during renewal')

/**
 * One process exchanges an authorization's rotating refresh token at a time:
 * `claim:linear-token-refresh/{integrationId}:{authorizationVersion}`. The
 * lease outlasts the 15 s exchange and is renewed until the result is saved.
 * Tokens live only in the integration row: everyone else waits for the row.
 */
const refreshClaims = defineLease({ name: 'claim:linear-token-refresh', ttlMs: 30_000 })
/** Long enough for a dead holder's claim to lapse and one more exchange to run. */
const REFRESH_WAIT_MS = refreshClaims.ttlMs + EXCHANGE_TIMEOUT_MS

/**
 * Exchanges whose outcome nobody has recorded, by the refresh token they spent
 * (a digest, never the token): `linear:unresolved-exchange/{integrationId}:
 * {authorizationVersion}:{digest}`. Written before an exchange is sent, cleared
 * once its result is saved or Linear refuses the token. One that stays (the
 * request failed or timed out, or its holder lost the claim or died) means
 * Linear may have rotated that token for a result nobody saved yet.
 *
 * It sits beside the claim, not in it, because it must outlast the claim it
 * was written under. `keep`: the window runs from the first unresolved
 * exchange of a token, however many tries follow it, so it always ends.
 */
const UNRESOLVED_WINDOW_MS = 2 * refreshClaims.ttlMs
const unresolvedExchanges = defineNamespace({
  name: 'linear:unresolved-exchange',
  consistency: 'strong',
  schema: z.object({ owner: z.string().min(1) }),
  expiry: { ttlMs: UNRESOLVED_WINDOW_MS, onUpdate: 'keep' },
})
const versionPart = (version: string | undefined) => version ?? 'unversioned'

/**
 * The row's tokens while they are fresh for `version`; undefined once they
 * need renewal. Throws when the row no longer holds that authorization.
 */
function freshAuthorization(config: LinearConfig, version: string | undefined): Authorization | undefined {
  if (config.authorizationVersion !== version || config.authorizationError || config.authorizationPending || !config.tokens) throw changedDuringRenewal()
  return config.tokens.expiresAt > Date.now() + REFRESH_BEFORE_EXPIRY_MS ? { tokens: config.tokens, authorizationVersion: version } : undefined
}

// Same-process callers share one renewal instead of each asking AppState.
const refreshes = new Map<string, Promise<Authorization>>()
async function tokenFor(id: string): Promise<Authorization> {
  const config = await getLinearConfig(id)
  if (config.authorizationError || config.authorizationPending || !config.tokens || !config.clientId || !config.clientSecret) throw new Error('Linear is not authorized')
  if (config.tokens.expiresAt > Date.now() + REFRESH_BEFORE_EXPIRY_MS) return { tokens: config.tokens, authorizationVersion: config.authorizationVersion }
  const version = config.authorizationVersion
  const key = `${id}:${versionPart(version)}`
  const existing = refreshes.get(key)
  if (existing) return existing
  const refresh = underClaim(id, version, holding => exchangeUnderClaim(id, version, holding))
    .finally(() => { if (refreshes.get(key) === refresh) refreshes.delete(key) })
  refreshes.set(key, refresh)
  return refresh
}

/**
 * Runs `work` as the claim's holder, or, while another process holds it,
 * re-reads the row until that process has saved fresh tokens there.
 */
async function underClaim(id: string, version: string | undefined, work: (holding: LeaseHolding) => Promise<Authorization>): Promise<Authorization> {
  const turn = await refreshClaims.acquireWhenFree(refreshClaims.key(id, versionPart(version)), {
    timeoutMs: REFRESH_WAIT_MS,
    whileWaiting: async () => freshAuthorization(await getLinearConfig(id), version),
  })
  return turn.acquired ? refreshClaims.hold(turn.lease, work) : turn.result
}

/**
 * The exchange, by the claim's holder. A holder sends the exchange and writes
 * only while it holds the claim: it confirms the lease (renews it) right before
 * sending and right before each write. The row's conditional
 * update (same refresh token, same authorization) is what keeps a write that
 * lands late anyway from overwriting newer credentials.
 *
 * Losing the claim cannot cancel an exchange Linear already received, and an
 * exchange whose result is lost may have rotated the token, which Linear then
 * refuses to the next holder. So:
 * - The exchange is not aborted when the claim is lost; that would only throw
 *   its result away. A holder that lost the claim with tokens in hand waits
 *   for the claim again and saves them as its holder (`saveLate`).
 * - When Linear refuses a token that an earlier exchange spent with no recorded
 *   outcome, the holder looks for that exchange's result in the row. Finding
 *   none, it throws `LinearRenewalPendingError` and keeps the authorization,
 *   since the result can still arrive. Once the window
 *   (`UNRESOLVED_WINDOW_MS` from the first unresolved exchange) has passed
 *   with nothing saved, the next refusal revokes, as every refusal did before.
 */
async function exchangeUnderClaim(id: string, version: string | undefined, holding: LeaseHolding): Promise<Authorization> {
  const latest = await getLinearConfig(id)
  // Another process renewed while this one waited for the claim.
  const fresh = freshAuthorization(latest, version)
  if (fresh) return fresh
  const { clientId, clientSecret, tokens: current } = latest
  if (!clientId || !clientSecret || !current) throw changedDuringRenewal()
  const refreshToken = current.refreshToken
  const unresolved = unresolvedExchanges.key(id, versionPart(version), digestKeyPart(refreshToken))
  holding.signal.throwIfAborted()
  // Recorded before the exchange is sent. A conflict is a write that landed
  // between the read and this one (a holder that has since lost the claim);
  // it is an earlier exchange of the same token too, so decide from it.
  let earlier = await appState().get(unresolved)
  let record: Revision
  for (;;) {
    const recorded = await appState().compareAndSet(unresolved, earlier?.revision ?? null, { owner: holding.owner })
    if (recorded.ok) {
      record = recorded.entry.revision
      break
    }
    earlier = recorded.current
  }
  // A renewal, not the abort flag: the reads and writes above can stall past
  // the lease while another process takes the claim and spends this token.
  // Nothing is awaited between this confirmation and the send.
  try {
    await holding.confirm()
  } catch (lost) {
    // Nothing was sent. A record this attempt created would make a later
    // refusal look uncertain; one it took over still stands for the earlier
    // exchange. Conditional: a successor's record is left alone.
    if (!earlier) await appState().consume(unresolved, { revision: record }).catch(() => undefined)
    throw lost
  }
  let tokens: LinearTokens
  try {
    tokens = await exchangeLinearToken({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret })
  } catch (error) {
    // Any other failure leaves the record: Linear may have rotated the token.
    if (!(error instanceof LinearAuthorizationError)) throw error
    if (earlier) return reconcileRefusal(id, version, refreshToken)
    await holding.confirm()
    await revokeLinearAuthorization(id, { refreshToken, authorizationVersion: version })
    await appState().consume(unresolved)
    throw error
  }
  try {
    await holding.confirm()
  } catch {
    return saveLate(id, version, refreshToken, tokens)
  }
  return save(id, version, refreshToken, tokens)
}

/** Saves renewed tokens in place of `refreshToken`, unless the row has moved on. */
async function save(id: string, version: string | undefined, refreshToken: string, tokens: LinearTokens): Promise<Authorization> {
  await updateLinearConfig(id, latest => {
    if (latest.tokens?.refreshToken !== refreshToken || latest.authorizationVersion !== version) throw changedDuringRenewal()
    return { ...latest, tokens }
  })
  // The row no longer holds the spent token, so no exchange of it is unresolved.
  await appState().consume(unresolvedExchanges.key(id, versionPart(version), digestKeyPart(refreshToken)))
  return { tokens, authorizationVersion: version }
}

/**
 * A holder lost the claim after Linear rotated the token for it. Its tokens
 * may be the only ones Linear still honours, so it takes the claim again,
 * waiting for any holder that took over, and saves them unless the row has
 * moved on meanwhile.
 */
async function saveLate(id: string, version: string | undefined, refreshToken: string, tokens: LinearTokens): Promise<Authorization> {
  return underClaim(id, version, async holding => {
    const fresh = freshAuthorization(await getLinearConfig(id), version)
    if (fresh) return fresh
    await holding.confirm()
    return save(id, version, refreshToken, tokens)
  })
}

/**
 * Linear refused a token that an earlier exchange spent with no recorded
 * outcome: that exchange may have rotated it, and its result may still be
 * saved. The row says whether it has been.
 */
async function reconcileRefusal(id: string, version: string | undefined, refreshToken: string): Promise<Authorization> {
  const latest = await getLinearConfig(id)
  const fresh = freshAuthorization(latest, version)
  if (fresh) return fresh
  if (latest.tokens?.refreshToken !== refreshToken) throw changedDuringRenewal()
  throw new LinearRenewalPendingError('Linear token renewal was interrupted and is being reconciled. Retry shortly.')
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
