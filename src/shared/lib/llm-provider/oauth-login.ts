import { startCodexLogin, pollCodexLogin } from './codex-oauth'
import { randomUUID } from 'node:crypto'
import { startGrokLogin, pollGrokLogin } from './grok-oauth'
import { startKimiLogin, pollKimiLogin, kimiRegion } from './kimi-oauth'
import { startMinimaxLogin, pollMinimaxLogin, minimaxRegion } from './minimax-oauth'
import type { OAuthCredential } from './oauth-schema'
import type { ConnectionViewer } from './connections'
import type { OAuthProvider } from './provider-types'
export type { OAuthProvider } from './provider-types'

type Device = { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval: number }
type PollResult = { pending: 'authorization_pending' | 'slow_down' } | { credential: OAuthCredential }
type DeviceFlow = { device: Device; poll: () => Promise<PollResult> }
// Each flow validates the options it understands; others ignore them.
export type OAuthLoginOptions = { region?: string }

const flows: Record<OAuthProvider, (options: OAuthLoginOptions) => Promise<DeviceFlow>> = {
  'grok-subscription': async () => {
    const { device, endpoints } = await startGrokLogin()
    return { device, poll: () => pollGrokLogin(device.device_code, endpoints.token_endpoint, endpoints.userinfo_endpoint) }
  },
  'codex-subscription': async () => {
    const { device } = await startCodexLogin()
    return { device, poll: () => pollCodexLogin(device.device_code, device.user_code) }
  },
  'kimi-subscription': async options => {
    const region = kimiRegion(options.region)
    const { device } = await startKimiLogin(region)
    return { device, poll: () => pollKimiLogin(device.device_code, region) }
  },
  'minimax-subscription': async options => {
    const region = minimaxRegion(options.region)
    const login = await startMinimaxLogin(region)
    return { device: login.device, poll: () => pollMinimaxLogin(login, region) }
  },
}

type Login = DeviceFlow & {
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
export async function startOAuthLogin(viewer: ConnectionViewer, owner: string | null, connectionId?: string, provider: OAuthProvider = 'grok-subscription', options: OAuthLoginOptions = {}) {
  for (const [id, login] of logins) if (login.expiresAt < Date.now()) logins.delete(id)
  if (logins.size >= 100) throw new Error('Too many pending sign-ins. Please retry shortly.')
  const result = await flows[provider](options)
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
      const result = await login.poll()
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
