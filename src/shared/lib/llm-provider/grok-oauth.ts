import { z } from 'zod'
import { oauthCredentialSchema, type OAuthCredential } from './oauth-schema'

// Public client used by OpenClaw, explicitly selected for this integration.
export const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const ISSUER = 'https://auth.x.ai'
const trustedUrl = z.url({ protocol: /^https$/, hostname: /(^|\.)x\.ai$/ })
const discoverySchema = z.object({ device_authorization_endpoint: trustedUrl, token_endpoint: trustedUrl, userinfo_endpoint: trustedUrl.optional() })
export const grokDeviceSchema = z.object({
  device_code: z.string(), user_code: z.string(), verification_uri: trustedUrl,
  verification_uri_complete: trustedUrl.optional(), expires_in: z.number().positive(), interval: z.number().positive().default(5),
})
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive() })
async function discovery() {
  const response = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
  if (!response.ok) throw new Error('Could not reach Grok sign-in')
  return discoverySchema.parse(await response.json())
}
async function exchange(endpoint: string, fields: Record<string, string>) {
  return fetch(trustedUrl.parse(endpoint), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: GROK_OAUTH_CLIENT_ID, ...fields }) })
}
async function credential(value: unknown, previous?: OAuthCredential): Promise<OAuthCredential> {
  const data = tokenSchema.parse(value)
  const refreshToken = data.refresh_token ?? previous?.refreshToken
  if (!refreshToken) throw new Error('Grok did not issue a refresh token. Please sign in again.')
  return oauthCredentialSchema.parse({ ...previous, accessToken: data.access_token, refreshToken, expiresAt: Date.now() + data.expires_in * 1000, refreshLease: undefined })
}
export async function startGrokLogin() {
  const endpoints = await discovery()
  const response = await exchange(endpoints.device_authorization_endpoint, { scope: 'openid profile email offline_access grok-cli:access api:access' })
  if (!response.ok) throw new Error('Could not start Grok sign-in')
  return { device: grokDeviceSchema.parse(await response.json()), endpoints }
}
export async function pollGrokLogin(deviceCode: string, tokenEndpoint: string, userinfoEndpoint?: string) {
  const response = await exchange(tokenEndpoint, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode })
  const data: unknown = await response.json()
  if (!response.ok) {
    const error = z.object({ error: z.string() }).parse(data).error
    if (error === 'authorization_pending' || error === 'slow_down') return { pending: error } as const
    throw new Error(error === 'access_denied' ? 'Grok sign-in was declined' : 'Grok sign-in expired. Start again.')
  }
  const tokens = await credential(data)
  if (userinfoEndpoint) {
    const identity = await fetch(trustedUrl.parse(userinfoEndpoint), { headers: { authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(15_000), redirect: 'error' })
    if (identity.ok) {
      const user = z.object({ sub: z.string().optional(), email: z.string().optional(), name: z.string().optional() }).parse(await identity.json())
      tokens.accountId = user.sub
      tokens.accountLabel = user.email ?? user.name ?? user.sub
    }
  }
  return { credential: tokens } as const
}
export async function refreshGrokCredential(previous: OAuthCredential): Promise<OAuthCredential> {
  const { token_endpoint } = await discovery()
  const response = await exchange(token_endpoint, { grant_type: 'refresh_token', refresh_token: previous.refreshToken })
  if (!response.ok) throw new Error('Grok sign-in expired or was revoked. Reconnect in Settings → Model Providers.')
  return credential(await response.json(), previous)
}
