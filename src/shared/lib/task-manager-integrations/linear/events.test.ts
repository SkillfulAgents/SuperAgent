import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { linearConfigSchema } from './config'
import { normalizeLinearWebhook, verifiedLinearWebhook, type LinearWebhook } from './events'
import { hashOAuthState, linearAppCreationUrl, linearAuthorization } from './oauth'

const config = linearConfigSchema.parse({ endpointId: 'endpoint', webhookUrl: 'https://relay.example/hooks/secret', memberId: 'member',
  redirectUri: 'http://localhost:47897/api/agent-integrations/linear/callback', clientId: 'client',
  identity: { workspaceId: 'workspace', workspaceName: 'Work', appUserId: 'app', appName: 'Helper' } })
const base: LinearWebhook = { type: 'AgentSessionEvent', action: 'created', organizationId: 'workspace', webhookTimestamp: 1700000000000,
  appUserId: 'app', oauthClientId: 'client', agentSession: { id: 'session-a', issueId: 'issue-a', appUserId: 'app' } }
function envelope(payload = base) {
  const body = JSON.stringify(payload)
  return { kind: 'event', verified: true, body, body_encoding: 'utf8', received_at: new Date(base.webhookTimestamp).toISOString(),
    headers: { 'Linear-Signature': createHmac('sha256', 'secret').update(body).digest('hex') } }
}
describe('Linear events', () => {
  it('verifies the raw body at relay receipt time, allowing offline queue delivery', () => {
    expect(verifiedLinearWebhook(envelope(), 'secret')).toEqual(base)
    expect(verifiedLinearWebhook({ ...envelope(), body: JSON.stringify({ ...base, organizationId: 'other' }) }, 'secret')).toBeNull()
    expect(verifiedLinearWebhook({ ...envelope(), verified: false }, 'secret')).toBeNull()
    expect(verifiedLinearWebhook({ ...envelope(), received_at: new Date(base.webhookTimestamp + 61000).toISOString() }, 'secret')).toBeNull()
    expect(verifiedLinearWebhook({ ...envelope(), headers: { 'Linear-Signature': 'a' } }, 'secret')).toBeNull()
    expect(verifiedLinearWebhook({ ...envelope(), body: Buffer.from(envelope().body).toString('base64'), body_encoding: 'base64' }, 'secret')).toEqual(base)
  })
  it('keys native invocations by session or activity, keeping the issue as route', () => {
    const event = normalizeLinearWebhook(base, config, () => false)
    expect(event).toMatchObject({ type: 'event', event: { id: 'created:session-a', taskId: 'issue-a', replyTarget: { agentSessionId: 'session-a' } } })
    expect(normalizeLinearWebhook({ ...base, action: 'prompted', agentActivity: { id: 'activity-b', content: { type: 'prompt', body: 'Continue' }, userId: 'human' } }, config, () => false))
      .toMatchObject({ type: 'event', event: { id: 'prompted:activity-b', taskId: 'issue-a', text: 'Continue' } })
  })
  it('rejects other identities and self-authored events', () => {
    for (const patch of [{ organizationId: 'other' }, { appUserId: 'other' }, { oauthClientId: 'other' }, { agentActivity: { id: 'activity', userId: 'app' } }]) {
      expect(normalizeLinearWebhook({ ...base, ...patch }, config, () => true)).toBeNull()
    }
    expect(normalizeLinearWebhook({ ...base, action: 'prompted', agentActivity: { id: 'activity', content: { type: 'response', body: 'Done' } } }, config, () => true)).toBeNull()
  })
  it('routes stop and revocation as controls, not work', () => {
    expect(normalizeLinearWebhook({ ...base, agentActivity: { id: 'activity', signal: 'stop' } }, config, () => true)).toEqual({ type: 'stop', taskId: 'issue-a', interactionId: 'session-a' })
    expect(normalizeLinearWebhook({ ...base, type: 'OAuthAuthorization', activeTokensForUser: 0, userId: 'app' }, config, () => true)).toEqual({ type: 'revoke' })
  })
  it('only wakes on opted-in state changes for involved issues', () => {
    const update = { ...base, type: 'Issue', action: 'update', data: { id: 'issue-a', stateId: 'done' }, updatedFrom: { stateId: 'todo' } }
    expect(normalizeLinearWebhook(update, config, () => false)).toBeNull()
    expect(normalizeLinearWebhook(update, config, () => true)).toMatchObject({ type: 'event', event: { kind: 'context' } })
    expect(normalizeLinearWebhook(update, { ...config, runOnStatusChange: true }, () => true)).toMatchObject({ type: 'event', event: { kind: 'status' } })
    expect(normalizeLinearWebhook({ ...update, actor: { id: 'app' } }, { ...config, runOnStatusChange: true }, () => true)).toBeNull()
    expect(normalizeLinearWebhook({ ...update, data: { id: 'issue-a', delegateId: null }, updatedFrom: { delegateId: 'app' } }, config, () => true)).toEqual({ type: 'stop', taskId: 'issue-a' })
  })
})
describe('Linear OAuth URLs', () => {
  it('prefills a separate private app without credentials', () => {
    const url = new URL(linearAppCreationUrl('Linear Helper', config))
    expect(url.searchParams.get('distribution')).toBe('private')
    expect(url.searchParams.get('oauth.client_name')).toBe('Helper')
    expect(url.searchParams.get('oauth.redirect_uris')).toBe(config.redirectUri)
    expect(url.searchParams.getAll('webhook.resourceTypes')).toContain('AgentSessionEvent')
  })
  it('uses app actor, scoped permissions, random one-use state, and PKCE', () => {
    const authorization = linearAuthorization(config)
    const url = new URL(authorization.url)
    expect(url.searchParams.get('actor')).toBe('app')
    expect(url.searchParams.get('scope')).toBe('read,write,app:mentionable,app:assignable')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(hashOAuthState(url.searchParams.get('state')!)).toBe(authorization.oauth.stateHash)
    expect(linearAuthorization(config).oauth.stateHash).not.toBe(authorization.oauth.stateHash)
  })
})
