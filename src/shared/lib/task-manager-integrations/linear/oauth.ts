import { createHash, randomBytes } from 'node:crypto'
import { LINEAR_SCOPES, type LinearConfig } from './config'

export function hashOAuthState(state: string): string { return createHash('sha256').update(state).digest('hex') }
export function linearAppCreationUrl(name: string, config: Pick<LinearConfig, 'redirectUri'>): string {
  const url = new URL('https://linear.app/settings/api/applications/new')
  const appName = name.replace(/linear|https?:\/\//gi, '').trim().slice(0, 70) || 'Gamut Agent'
  const params: Record<string, string> = {
    distribution: 'private', 'oauth.client_name': appName.length < 2 ? `${appName} Agent` : appName,
    'oauth.client_uri': 'https://gamutagents.com', 'oauth.redirect_uris': config.redirectUri,
    'oauth.grant_types': 'authorization_code', 'display.description': `${appName} agent in your Linear workspace`,
    'developer.name': 'Gamut', 'webhook.enabled': 'false',
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}
export function linearAuthorization(config: LinearConfig) {
  if (!config.clientId) throw new Error('Missing Linear client ID')
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const url = new URL('https://linear.app/oauth/authorize')
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
    response_type: 'code', actor: 'app', scope: LINEAR_SCOPES.join(','), state,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString()
  return { url: url.toString(), oauth: { stateHash: hashOAuthState(state), verifier, expiresAt: Date.now() + 15 * 60000 } }
}
