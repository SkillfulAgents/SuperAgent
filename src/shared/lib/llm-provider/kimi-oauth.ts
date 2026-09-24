import { CredentialRefreshError } from '../../../../agent-container/src/credential-refresh-error'
import { z } from 'zod'
import { oauthCredentialSchema, type OAuthCredential } from './oauth-schema'

// Public client of the official Kimi Code CLI; shared by both regions.
export const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
// Accounts belong to one deployment: international accounts on kimi.ai, mainland China accounts on kimi.com.
export const KIMI_HOSTS = {
  us: { auth: 'https://auth.kimi.ai', api: 'https://api.kimi.ai/coding' },
  cn: { auth: 'https://auth.kimi.com', api: 'https://api.kimi.com/coding' },
} as const
export type KimiRegion = keyof typeof KIMI_HOSTS
export const kimiRegion = (value: unknown): KimiRegion => z.enum(['us', 'cn']).default('us').parse(value)
// Kimi asks integrations to identify themselves truthfully; its auth edge also rejects blank agents.
export const KIMI_HEADERS = { 'user-agent': 'SuperAgent' }
const trustedUrl = z.url({ protocol: /^https$/, hostname: /(^|\.)kimi\.(ai|com)$/ })
export const kimiDeviceSchema = z.object({
  device_code: z.string(), user_code: z.string(), verification_uri: trustedUrl,
  verification_uri_complete: trustedUrl.optional(), expires_in: z.number().positive(), interval: z.number().positive().default(5),
})
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive() })

async function exchange(region: KimiRegion, path: string, fields: Record<string, string>) {
  return fetch(`${KIMI_HOSTS[region].auth}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { ...KIMI_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: KIMI_OAUTH_CLIENT_ID, ...fields }) })
}
function credential(value: unknown, region: KimiRegion, previous?: OAuthCredential): OAuthCredential {
  const data = tokenSchema.parse(value)
  const refreshToken = data.refresh_token ?? previous?.refreshToken
  if (!refreshToken) throw new Error('Kimi did not issue a refresh token. Please sign in again.')
  return oauthCredentialSchema.parse({ ...previous, region, accessToken: data.access_token, refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000, refreshLease: undefined, refreshFailure: undefined })
}
export async function startKimiLogin(region: KimiRegion) {
  const response = await exchange(region, '/api/oauth/device_authorization', {})
  if (!response.ok) { await response.body?.cancel(); throw new Error('Could not start Kimi sign-in') }
  return { device: kimiDeviceSchema.parse(await response.json()) }
}
export async function pollKimiLogin(deviceCode: string, region: KimiRegion) {
  const response = await exchange(region, '/api/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode })
  const data: unknown = await response.json()
  if (!response.ok) {
    const error = z.object({ error: z.string() }).parse(data).error
    if (error === 'authorization_pending' || error === 'slow_down') return { pending: error } as const
    throw new Error(error === 'access_denied' ? 'Kimi sign-in was declined' : 'Kimi sign-in expired. Start again.')
  }
  const tokens = credential(data, region)
  const identity = await fetch(`${KIMI_HOSTS[region].api}/v1/me`, {
    headers: { ...KIMI_HEADERS, authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(15_000), redirect: 'error',
  })
  if (identity.ok) {
    const user = z.object({ user_id: z.string().optional(), email: z.string().optional(), nickname: z.string().optional() }).parse(await identity.json())
    tokens.accountId = user.user_id
    tokens.accountLabel = user.email || user.nickname || user.user_id
  } else await identity.body?.cancel()
  return { credential: tokens } as const
}
export async function refreshKimiCredential(previous: OAuthCredential): Promise<OAuthCredential> {
  const region = kimiRegion(previous.region)
  const response = await exchange(region, '/api/oauth/token', { grant_type: 'refresh_token', refresh_token: previous.refreshToken })
  if (!response.ok) {
    await response.body?.cancel()
    throw new CredentialRefreshError(response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? 401 : 503)
  }
  return credential(await response.json(), region, previous)
}
