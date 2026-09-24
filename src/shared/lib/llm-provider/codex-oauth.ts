import { CredentialRefreshError } from '../../../../agent-container/src/credential-refresh-error'
import { z } from 'zod'
import { oauthCredentialSchema, type OAuthCredential } from './oauth-schema'

// Public client used by the official Codex CLI device-auth flow.
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ISSUER = 'https://auth.openai.com'
const claimsSchema = z.object({
  exp: z.number().optional(), email: z.string().optional(),
  'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().optional() }).optional(),
})
function claims(token: string) {
  // Metadata from the token exchange, not independent authorization evidence.
  try { return claimsSchema.parse(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())) }
  catch { throw new Error('Codex returned invalid account metadata. Sign in again.') }
}
function credentials(data: unknown, previous?: OAuthCredential): OAuthCredential {
  const token = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), id_token: z.string().optional(), expires_in: z.number().optional() }).parse(data)
  const refreshToken = token.refresh_token || previous?.refreshToken
  if (!refreshToken) throw new Error('Codex did not issue a refresh token. Please sign in again.')
  const access = claims(token.access_token)
  const identity = token.id_token ? claims(token.id_token) : access
  const accountId = access['https://api.openai.com/auth']?.chatgpt_account_id ?? identity['https://api.openai.com/auth']?.chatgpt_account_id ?? previous?.accountId
  if (!accountId) throw new Error('Codex did not return a subscription account. Sign in again.')
  return oauthCredentialSchema.parse({ accessToken: token.access_token,
    refreshToken,
    expiresAt: access.exp ? access.exp * 1000 : Date.now() + (token.expires_in ?? 3600) * 1000,
    accountId, accountLabel: identity.email ?? access.email ?? previous?.accountLabel ?? 'ChatGPT account',
  })
}
async function post(path: string, body: unknown) {
  return fetch(`${ISSUER}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
async function exchange(fields: Record<string, string>) {
  const response = await fetch(`${ISSUER}/oauth/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CODEX_OAUTH_CLIENT_ID, ...fields }) })
  if (!response.ok) throw new CredentialRefreshError(response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? 401 : 503)
  return response.json() as Promise<unknown>
}
export async function startCodexLogin() {
  const response = await post('/api/accounts/deviceauth/usercode', { client_id: CODEX_OAUTH_CLIENT_ID })
  if (!response.ok) throw new Error('Could not start Codex device sign-in. Check whether device code authentication is enabled for your ChatGPT account.')
  const data = z.object({ device_auth_id: z.string(), user_code: z.string().optional(), usercode: z.string().optional(), interval: z.coerce.number().positive().default(5) }).parse(await response.json())
  const code = data.user_code ?? data.usercode
  if (!code) throw new Error('Codex did not return a sign-in code')
  return { device: { device_code: data.device_auth_id, user_code: code, verification_uri: `${ISSUER}/codex/device`, verification_uri_complete: undefined, expires_in: 900, interval: data.interval },
    endpoints: { device_authorization_endpoint: `${ISSUER}/api/accounts/deviceauth/usercode`, token_endpoint: `${ISSUER}/oauth/token` } }
}
export async function pollCodexLogin(deviceCode: string, userCode: string) {
  const response = await post('/api/accounts/deviceauth/token', { device_auth_id: deviceCode, user_code: userCode })
  if (response.status === 403 || response.status === 404) return { pending: 'authorization_pending' } as const
  if (!response.ok) throw new Error('Codex sign-in failed. Start again.')
  const grant = z.object({ authorization_code: z.string(), code_verifier: z.string() }).parse(await response.json())
  return { credential: credentials(await exchange({ grant_type: 'authorization_code', code: grant.authorization_code,
    code_verifier: grant.code_verifier, redirect_uri: `${ISSUER}/deviceauth/callback` })) } as const
}
export async function refreshCodexCredential(previous: OAuthCredential) {
  return credentials(await exchange({ grant_type: 'refresh_token', refresh_token: previous.refreshToken }), previous)
}
