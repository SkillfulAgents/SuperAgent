import { generateKeyPairSync, createHmac } from 'node:crypto'
import type { GitHubConfig } from './config-schema'
import type { RelayEvent } from '../../webhook-relay'

export const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
export const appIdentity = { id: '123', slug: 'release-helper', name: 'Release Helper', owner: 'team', privateKey, webhookSecret: 'test-signing-secret' }
export const configured: GitHubConfig = { redirectUri: 'https://host.test/api/agent-integrations/providers/github/callback',
  app: appIdentity, installation: { id: 456, account: 'team', botId: 9 }, authorizationVersion: 'version-1',
  relay: { endpointId: 'endpoint', url: 'https://relay.test/hooks/endpoint', scope: 'member' } }
export const person = { id: 1, login: 'writer', type: 'User' }
export const repository = { name: 'project', owner: { id: 2, login: 'team' } }
export const issue = { id: 42, number: 3, title: 'Ship it', body: 'Do the thing', html_url: 'https://github.com/team/project/issues/3', updated_at: '2026-10-13T12:00:00Z', state: 'open', user: person }
export const comment = { id: 11, body: '@release-helper please help', html_url: `${issue.html_url}#issuecomment-11`, user: person, created_at: issue.updated_at, updated_at: issue.updated_at }
export const body = { action: 'created', installation: { id: 456 }, repository, issue, sender: person, comment }
export function delivery(payload: object = body, type = 'issue_comment', deliveryId = 'delivery-1', secret = appIdentity.webhookSecret, base64 = false): RelayEvent {
  const raw = JSON.stringify(payload)
  return { id: `relay-${deliveryId}`, endpointId: 'endpoint', type: 'CUSTOM_WEBHOOK', createdAt: issue.updated_at,
    payload: { kind: 'event', verified: false, body: base64 ? Buffer.from(raw).toString('base64') : raw, body_encoding: base64 ? 'base64' : 'utf8',
      headers: { 'x-github-event': type, 'x-github-delivery': deliveryId, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } } }
}
