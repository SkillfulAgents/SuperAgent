import { startCodexLogin, pollCodexLogin } from './codex-oauth'
import { randomUUID } from 'node:crypto'
import { expiringMap } from '@shared/lib/host-state/expiring-map'
import { startGrokLogin, pollGrokLogin } from './grok-oauth'
import { startKimiLogin, pollKimiLogin, kimiRegion } from './kimi-oauth'
import { startMinimaxLogin, pollMinimaxLogin, minimaxRegion } from './minimax-oauth'
import { oauthLoginSchema, type OAuthDevice, type OAuthFlowState, type OAuthLogin } from './oauth-login-schema'
import type { OAuthCredential } from './oauth-schema'
import type { ConnectionViewer } from './connections'
import type { OAuthProvider } from './provider-types'
export type { OAuthProvider } from './provider-types'

type PollResult = { pending: 'authorization_pending' | 'slow_down' } | { credential: OAuthCredential }
// Each flow validates the options it understands; others ignore them.
export type OAuthLoginOptions = { region?: string }

const flows: Record<OAuthProvider, (options: OAuthLoginOptions) => Promise<{ device: OAuthDevice; flow: OAuthFlowState }>> = {
  'grok-subscription': async () => {
    const { device, endpoints } = await startGrokLogin()
    return { device, flow: { provider: 'grok-subscription', tokenEndpoint: endpoints.token_endpoint, userinfoEndpoint: endpoints.userinfo_endpoint } }
  },
  'codex-subscription': async () => {
    const { device } = await startCodexLogin()
    return { device, flow: { provider: 'codex-subscription' } }
  },
  'kimi-subscription': async options => {
    const region = kimiRegion(options.region)
    const { device } = await startKimiLogin(region)
    return { device, flow: { provider: 'kimi-subscription', region } }
  },
  'minimax-subscription': async options => {
    const region = minimaxRegion(options.region)
    const login = await startMinimaxLogin(region)
    return { device: login.device, flow: { provider: 'minimax-subscription', region, login } }
  },
}

function poll(login: OAuthLogin): Promise<PollResult> {
  const { flow, device } = login
  switch (flow.provider) {
    case 'grok-subscription': return pollGrokLogin(device.device_code, flow.tokenEndpoint, flow.userinfoEndpoint)
    case 'codex-subscription': return pollCodexLogin(device.device_code, device.user_code)
    case 'kimi-subscription': return pollKimiLogin(device.device_code, flow.region)
    case 'minimax-subscription': return pollMinimaxLogin(flow.login, flow.region)
  }
}

// Sealed in a shared store: it carries the flow's secrets and, once signed in, the credential.
const logins = expiringMap('llm-oauth-login', 15 * 60 * 1000, oauthLoginSchema, { sealed: true })

async function requireLogin(id: string, viewer: ConnectionViewer) {
  const login = await logins.get(id)
  if (!login || login.actor !== viewer.userId || (login.owner === null && !viewer.admin) || login.expiresAt < Date.now()) {
    throw new Error('Sign-in expired. Start again.')
  }
  return login
}
export async function startOAuthLogin(viewer: ConnectionViewer, owner: string | null, connectionId?: string, provider: OAuthProvider = 'grok-subscription', options: OAuthLoginOptions = {}) {
  if ((await logins.values('')).length >= 100) throw new Error('Too many pending sign-ins. Please retry shortly.')
  const { device, flow } = await flows[provider](options)
  const id = randomUUID()
  const expiresAt = Date.now() + device.expires_in * 1000
  await logins.set(id, { flow, device, actor: viewer.userId, owner, connectionId, expiresAt, nextPollAt: 0 }, device.expires_in * 1000)
  return { id, url: device.verification_uri_complete ?? device.verification_uri, code: device.user_code, expiresAt, interval: device.interval }
}
export async function pollOAuthLogin(id: string, viewer: ConnectionViewer) {
  let login = await requireLogin(id, viewer)
  if (!login.credential && Date.now() >= login.nextPollAt) {
    // Claim the poll: of the requests that see it due, one asks the provider.
    const claim = randomUUID()
    const claimed = await logins.update(id, current =>
      current.credential || Date.now() < current.nextPollAt
        ? undefined
        : { ...current, nextPollAt: Date.now() + current.device.interval * 1000, pollClaim: claim })
    if (claimed?.pollClaim === claim && !claimed.credential) {
      const result = await poll(claimed)
      login = await logins.update(id, current => {
        if ('credential' in result) return { ...current, credential: result.credential }
        if (result.pending !== 'slow_down') return undefined
        const interval = current.device.interval + 5
        return { ...current, device: { ...current.device, interval }, nextPollAt: Date.now() + interval * 1000 }
      }) ?? login
    } else if (claimed) {
      login = claimed
    }
  }
  return login.credential ? { status: 'connected' as const, accountLabel: login.credential.accountLabel ?? 'Subscription account' } : { status: 'pending' as const }
}
export async function credentialsFromLogin(id: string, viewer: ConnectionViewer, owner: string | null, connectionId?: string, provider: OAuthProvider = 'grok-subscription'): Promise<OAuthCredential> {
  const login = await requireLogin(id, viewer)
  if (login.flow.provider !== provider || login.owner !== owner || login.connectionId !== connectionId || !login.credential) throw new Error('Complete sign-in for this connection first')
  return login.credential
}
export async function consumeOAuthLogin(id: string): Promise<void> { await logins.delete(id) }
