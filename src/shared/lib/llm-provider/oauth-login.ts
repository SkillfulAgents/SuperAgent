import { startCodexLogin, pollCodexLogin } from './codex-oauth'
import { randomUUID } from 'node:crypto'
import { startGrokLogin, pollGrokLogin } from './grok-oauth'
import type { OAuthCredential } from './oauth-schema'
import type { ConnectionViewer } from './connections'

export type OAuthProvider = 'grok-subscription' | 'codex-subscription'

type Login = Awaited<ReturnType<typeof startGrokLogin>> & {
  provider: OAuthProvider
  actor: string | null
  owner: string | null
  connectionId?: string
  expiresAt: number
  nextPollAt: number
  credential?: OAuthCredential
  polling?: Promise<void>
}
const logins = new Map<string, Login>()
function requireLogin(id: string, viewer: ConnectionViewer) {
  const login = logins.get(id)
  if (!login || login.actor !== viewer.userId || (login.owner === null && !viewer.admin) || login.expiresAt < Date.now()) {
    throw new Error('Sign-in expired. Start again.')
  }
  return login
}
export async function startOAuthLogin(viewer: ConnectionViewer, owner: string | null, connectionId?: string, provider: OAuthProvider = 'grok-subscription') {
  for (const [id, login] of logins) if (login.expiresAt < Date.now()) logins.delete(id)
  if (logins.size >= 100) throw new Error('Too many pending sign-ins. Please retry shortly.')
  const result = provider === 'codex-subscription' ? await startCodexLogin() : await startGrokLogin()
  const id = randomUUID()
  const expiresAt = Date.now() + result.device.expires_in * 1000
  logins.set(id, { ...result, provider, actor: viewer.userId, owner, connectionId, expiresAt, nextPollAt: 0 })
  return { id, url: result.device.verification_uri_complete ?? result.device.verification_uri, code: result.device.user_code, expiresAt, interval: result.device.interval }
}
export async function pollOAuthLogin(id: string, viewer: ConnectionViewer) {
  const login = requireLogin(id, viewer)
  if (!login.credential && Date.now() >= login.nextPollAt) {
    login.polling ??= (async () => {
      login.nextPollAt = Date.now() + login.device.interval * 1000
      const result = login.provider === 'codex-subscription'
        ? await pollCodexLogin(login.device.device_code, login.device.user_code)
        : await pollGrokLogin(login.device.device_code, login.endpoints.token_endpoint, login.endpoints.userinfo_endpoint)
      if ('credential' in result) login.credential = result.credential
      else if (result.pending === 'slow_down') {
        login.device.interval += 5
        login.nextPollAt = Date.now() + login.device.interval * 1000
      }
    })().finally(() => { login.polling = undefined })
    await login.polling
  }
  return login.credential ? { status: 'connected' as const, accountLabel: login.credential.accountLabel ?? 'Subscription account' } : { status: 'pending' as const }
}
export function credentialsFromLogin(id: string, viewer: ConnectionViewer, owner: string | null, connectionId?: string, provider: OAuthProvider = 'grok-subscription'): OAuthCredential {
  const login = requireLogin(id, viewer)
  if (login.provider !== provider || login.owner !== owner || login.connectionId !== connectionId || !login.credential) throw new Error('Complete sign-in for this connection first')
  return login.credential
}
export function consumeOAuthLogin(id: string): void { logins.delete(id) }
