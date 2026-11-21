import { Client, PUBLIC } from '@microsoft/teams.api/dist/index.js'
import { InboundActivityTokenValidator } from '@microsoft/teams.apps/dist/middleware/index.js'
import { decodeJwt } from 'jose'
import { z } from 'zod'
import { isTeamsInlineImageUrl, isTeamsServiceHost } from './teams-files'
import { teamsIdentitySchema, type TeamsConfig } from './config-schema'

const envelope = z.object({
  channelId: z.literal('msteams'),
  serviceUrl: z.string().url(),
  channelData: z.object({ tenant: z.object({ id: z.string() }).optional() }).optional(),
  conversation: z.object({ tenantId: z.string().optional() }),
  recipient: z.object({ id: z.string() }),
})
const accessTokenResponse = z.object({
  token_type: z.literal('Bearer'),
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
})
const outboundActivity = z.object({ type: z.enum(['message', 'typing']) }).loose()

/** The untrusted routing hint is checked again against the installation and Microsoft's signature. */
export function teamsActivityIdentity(activity: unknown) {
  const parsed = envelope.safeParse(activity)
  if (!parsed.success) return null
  const { channelData, conversation, recipient } = parsed.data
  const tenant = channelData?.tenant?.id?.toLowerCase()
  const conversationTenant = conversation.tenantId?.toLowerCase()
  if (tenant && conversationTenant && tenant !== conversationTenant) return null
  const identity = teamsIdentitySchema.safeParse({
    tenantId: tenant ?? conversationTenant,
    appId: recipient.id.replace(/^28:/, ''),
  })
  return identity.success ? identity.data : null
}

/** Only Microsoft's commercial Teams connector receives the bot's service credentials. */
function teamsServiceUrl(value: string): string {
  const url = URL.parse(value)
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !isTeamsServiceHost(url.hostname)) {
    throw new Error('Unrecognized Microsoft Teams service URL')
  }
  return url.href.replace(/\/+$/, '')
}

export async function verifyTeamsActivity(
  authorization: string, activity: unknown, installation: Pick<TeamsConfig, 'appId' | 'tenantId'>,
  validator = new InboundActivityTokenValidator(installation.appId, installation.tenantId),
): Promise<void> {
  const identity = teamsActivityIdentity(activity)
  if (!identity || identity.appId !== installation.appId || identity.tenantId !== installation.tenantId) {
    throw new Error('Activity does not match the Teams installation')
  }
  const body = envelope.parse(activity)
  teamsServiceUrl(body.serviceUrl)
  const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1]
  if (!token) throw new Error('A Microsoft Bot Connector bearer token is required')
  // The SDK supports Agent 365 callers as well. This installation is a traditional single-tenant bot.
  const claims = decodeJwt(token)
  if (claims.iss !== PUBLIC.tokenIssuer || claims.aud !== installation.appId || typeof claims.exp !== 'number'
    || typeof claims.serviceurl !== 'string'
    || teamsServiceUrl(claims.serviceurl) !== teamsServiceUrl(body.serviceUrl)) {
    throw new Error('Invalid Microsoft Bot Connector claims')
  }
  await validator.check(`Bearer ${token}`, body)
}

class TeamsRequestError extends Error {
  constructor(readonly status?: number) {
    super(status ? `Microsoft Teams request failed (HTTP ${status})` : 'Microsoft Teams could not be reached')
  }
}

function pathId(id: string): string {
  if (!id || id === '.' || id === '..') throw new Error('Invalid Teams resource identifier')
  return encodeURIComponent(id)
}

export class TeamsApi {
  private readonly validator: InboundActivityTokenValidator
  private token?: { value: string; expiresAt: number }
  private refreshing?: Promise<string>

  constructor(private readonly config: TeamsConfig) {
    this.validator = new InboundActivityTokenValidator(config.appId, config.tenantId)
  }

  authenticate(authorization: string, activity: unknown): Promise<void> {
    return verifyTeamsActivity(authorization, activity, this.config, this.validator)
  }

  async fetchInlineImage(url: string): Promise<Response> {
    if (!isTeamsInlineImageUrl(url)) throw new Error('Invalid Teams inline image attachment URL')
    return fetch(url, {
      headers: { Authorization: `Bearer ${await this.getToken()}` },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    })
  }

  async checkCredentials(): Promise<void> {
    await this.getToken()
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value
    this.refreshing ??= this.requestToken().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  private async requestToken(): Promise<string> {
    const { tenantId, appId, clientSecret } = this.config
    const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: appId, client_secret: clientSecret,
        scope: 'https://api.botframework.com/.default',
      }),
    })
    if (!response.ok) throw new Error(`Microsoft token request failed (HTTP ${response.status})`)
    const parsed = accessTokenResponse.safeParse(await response.json())
    if (!parsed.success) throw new Error('Microsoft returned an invalid bot token response')
    this.token = { value: parsed.data.access_token, expiresAt: Date.now() + (parsed.data.expires_in - 60) * 1000 }
    return this.token.value
  }

  private conversations(serviceUrl: string) {
    return new Client(teamsServiceUrl(serviceUrl), {
      token: () => this.getToken(),
      timeout: 15_000,
      middlewares: [{
        async invoke({ config }, next) {
          config.maxRedirects = 0
          try {
            return await next()
          } catch (error) {
            // SDK errors carry the request, including the bot's Authorization header.
            const failure = z.object({ response: z.object({ status: z.number() }) }).safeParse(error)
            throw new TeamsRequestError(failure.success ? failure.data.response.status : undefined)
          }
        },
      }],
    }).conversations
  }

  private activity(conversationId: string, activity: Record<string, unknown>) {
    return outboundActivity.parse({
      ...activity,
      from: { id: `28:${this.config.appId}` },
      conversation: { id: conversationId, tenantId: this.config.tenantId },
    })
  }

  async sendActivity(serviceUrl: string, conversationId: string, activity: Record<string, unknown>, replyToId?: string): Promise<string> {
    const client = this.conversations(serviceUrl)
    const body = this.activity(conversationId, activity)
    const posted = replyToId
      ? await client.replyToActivity(pathId(conversationId), replyToId, body)
      : await client.createActivity(pathId(conversationId), body)
    if (body.type === 'typing') return posted?.id ?? ''
    if (!posted?.id) throw new Error('Microsoft Teams returned no message ID')
    return posted.id
  }

  async sendThreadActivity(serviceUrl: string, scopeId: string, threadRoot: string, conversationId: string,
    scopeType: 'personal' | 'channel' | 'groupChat', activity: Record<string, unknown>): Promise<string> {
    try {
      const posted = await this.conversations(serviceUrl).createReplyChainActivity(scopeId, threadRoot, this.activity(scopeId, activity))
      if (!posted?.id) throw new Error('Microsoft Teams returned no thread message ID')
      return posted.id
    } catch (error) {
      // Classic channels address the thread through the original activity's wire conversation id.
      if (scopeType !== 'channel' || !(error instanceof TeamsRequestError) || error.status !== 404) throw error
      return this.sendActivity(serviceUrl, conversationId, activity, threadRoot)
    }
  }

  async updateActivity(serviceUrl: string, conversationId: string, activityId: string, activity: Record<string, unknown>): Promise<void> {
    await this.conversations(serviceUrl).updateActivity(pathId(conversationId), pathId(activityId), this.activity(conversationId, activity))
  }

  async deleteActivity(serviceUrl: string, conversationId: string, activityId: string): Promise<void> {
    await this.conversations(serviceUrl).deleteActivity(pathId(conversationId), pathId(activityId))
  }

  async setReaction(serviceUrl: string, conversationId: string, activityId: string, name: string, add: boolean): Promise<void> {
    const client = this.conversations(serviceUrl)
    if (add) await client.addReaction(pathId(conversationId), pathId(activityId), pathId(name))
    else await client.deleteReaction(pathId(conversationId), pathId(activityId), pathId(name))
  }
}
