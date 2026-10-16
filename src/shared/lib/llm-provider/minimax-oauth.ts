import { createHash, randomBytes } from 'node:crypto'
import { CredentialRefreshError } from '../../../../agent-container/src/credential-refresh-error'
import { z } from 'zod'
import { oauthCredentialSchema, type OAuthCredential } from './oauth-schema'

// Public client of the official MiniMax CLI; shared by both regions.
export const MINIMAX_OAUTH_CLIENT_ID = '659cf4c1-615c-45f6-a5f6-4bf15eb476e5'
export const MINIMAX_HOSTS = {
  global: { auth: 'https://account.minimax.io', api: 'https://api.minimax.io' },
  cn: { auth: 'https://account.minimaxi.com', api: 'https://api.minimaxi.com' },
} as const
export type MinimaxRegion = keyof typeof MINIMAX_HOSTS
export const minimaxRegion = (value: unknown): MinimaxRegion => z.enum(['global', 'cn']).default('global').parse(value)
export const MINIMAX_HEADERS = { 'user-agent': 'SuperAgent' }
const SCOPES = 'openid profile coding_plan'
const trustedUrl = z.url({ protocol: /^https$/, hostname: /(^|\.)(minimax\.io|minimaxi\.com)$/ })
const deviceSchema = z.object({
  user_code: z.string().min(1),
  verification_uri: trustedUrl,
  expired_in: z.number().positive(),
  interval: z.number().positive().default(3000),
  state: z.string(),
})
const tokenSchema = z.object({
  status: z.string(),
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  // Absolute Unix milliseconds, not a duration.
  expired_in: z.number().positive().optional(),
})
type Device = { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }
export type MinimaxLogin = { device: Device; userCode: string; verifier: string }

async function exchange(region: MinimaxRegion, path: string, fields: Record<string, string>) {
  return fetch(`${MINIMAX_HOSTS[region].auth}${path}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { ...MINIMAX_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MINIMAX_OAUTH_CLIENT_ID, ...fields }),
  })
}
function credential(value: { access_token?: string; refresh_token?: string; expired_in?: number }, region: MinimaxRegion, previous?: OAuthCredential): OAuthCredential {
  const refreshToken = value.refresh_token ?? previous?.refreshToken
  if (!value.access_token || !refreshToken || !value.expired_in) throw new Error('MiniMax did not issue a refresh token. Please sign in again.')
  return oauthCredentialSchema.parse({
    ...previous, region, accessToken: value.access_token, refreshToken, expiresAt: value.expired_in,
    refreshLease: undefined, refreshFailure: undefined,
  })
}
export async function startMinimaxLogin(region: MinimaxRegion): Promise<MinimaxLogin> {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('base64url')
  const response = await exchange(region, '/oauth2/device/code', {
    scope: SCOPES, code_challenge: challenge, code_challenge_method: 'S256', state,
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error('Could not start MiniMax sign-in') }
  const data = deviceSchema.parse(await response.json())
  if (data.state !== state) throw new Error('MiniMax sign-in could not be verified')
  return {
    verifier, userCode: data.user_code,
    device: {
      device_code: state, user_code: data.user_code, verification_uri: data.verification_uri,
      expires_in: Math.max(1, Math.ceil((data.expired_in - Date.now()) / 1000)),
      interval: Math.max(1, Math.round(data.interval / 1000)),
    },
  }
}
export async function pollMinimaxLogin(login: MinimaxLogin, region: MinimaxRegion) {
  const response = await exchange(region, '/oauth2/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code', user_code: login.userCode, code_verifier: login.verifier,
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error('MiniMax sign-in failed') }
  const body = tokenSchema.parse(await response.json())
  if (body.status === 'pending') return { pending: 'authorization_pending' } as const
  if (body.status !== 'success') throw new Error('MiniMax sign-in was declined')
  return { credential: credential(body, region) } as const
}
export async function refreshMinimaxCredential(previous: OAuthCredential): Promise<OAuthCredential> {
  const region = minimaxRegion(previous.region)
  const response = await exchange(region, '/oauth2/token', { grant_type: 'refresh_token', refresh_token: previous.refreshToken })
  if (!response.ok) {
    await response.body?.cancel()
    throw new CredentialRefreshError(response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? 401 : 503)
  }
  const body = tokenSchema.parse(await response.json())
  if (body.status !== 'success') throw new CredentialRefreshError(401)
  return credential(body, region, previous)
}
