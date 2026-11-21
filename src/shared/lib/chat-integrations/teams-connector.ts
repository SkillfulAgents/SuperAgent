import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { agentRegistry } from '../agent-actor'
import { isAuthMode } from '../auth/mode'
import { resolveInternetAppBaseUrl, withSessionUrl, type AppLinkContext } from '../agent-integrations/app-link'
import { relayAcceptResult } from '../agent-integrations/relay-transport'
import type { IntegrationRelayAttachment } from '../agent-integrations/transport'
import type { AgentIntegrationRecord, IntegrationInputEvent, IntegrationInputResult, IntegrationOutput, IntegrationSessionContext } from '../agent-integrations/types'
import { isChatAllowed } from '../services/chat-integration-access-service'
import { webhookEnvelopeSchema } from '../services/webhook-endpoint-schema'
import type { UserRequestEvent } from '../tools/types'
import { imageDimensions } from '../utils/image-dimensions'
import { guessMimeType } from '../utils/mime'
import { publicWorkspaceFileUrl } from '../utils/workspace-file-url'
import type { RelayAcceptResult } from '../webhook-relay/types'
import { ChatAgentIntegration, type ChatClassifyContext, type OutgoingMessage, type SendFileOptions } from './chat-agent-integration'
import type { TeamsConfig } from './config-schema'
import { describeUnsupportedRequest, splitChatMessage } from './utils'
import { incomingMessageSchema } from './message-schema'
import { TeamsApi } from './teams-api'
import { createTeamsSocket } from './teams-socket'
import {
  matchesTeamsInstallation, sameTeamsApp, teamsActivitySchema, teamsChatScope, teamsExternalId, teamsIncomingMessage,
  teamsParentChatId, teamsScopeId, type TeamsActivity,
} from './teams-activity'
import {
  adaptiveCard, adaptiveContentType, adaptiveReply, executeAction, fileConsentAction,
  teamsFileEvent, teamsQuestionAnswers, teamsQuestionCard, type TeamsCard,
} from './teams-card-schema'
import { TeamsConversationStore } from './teams-conversation-store'
import { isTeamsFileUrl, uploadTeamsFile } from './teams-files'

const textActivity = (text: string) => ({ type: 'message', textFormat: 'markdown', text })
const cardActivity = (content: unknown, summary: string) => ({ type: 'message', summary, attachments: [{ contentType: adaptiveContentType, content }] })
const maxText = 8000
const fileDigest = (data: Buffer) => createHash('sha256').update(data).digest('hex')
type InvokeResponse = { status: number; body?: unknown }
type SavedCard = NonNullable<Awaited<ReturnType<TeamsConversationStore['card']>>>

export class TeamsConnector extends ChatAgentIntegration {
  readonly provider = 'teams' as const
  readonly api: TeamsApi
  private readonly references?: TeamsConversationStore
  private connected = false
  private socket?: ReturnType<typeof createTeamsSocket>
  private relay?: IntegrationRelayAttachment

  constructor(private readonly config: TeamsConfig, private appLink?: AppLinkContext, private record?: AgentIntegrationRecord) {
    super()
    this.api = new TeamsApi(config)
    if (record) this.references = new TeamsConversationStore(record.id, config.tenantId, config.appId)
  }
  private get store() {
    if (!this.references) throw new Error('Teams installation is unavailable')
    return this.references
  }
  static discoveryCapabilities = ['list_users', 'list_channels', 'dm_by_user_id'] as const
  async listChatUsers() {
    const rows = await this.store.destinations(true)
    return { items: rows.slice(0, 200).map(row => ({ id: row.userId, name: row.userName || row.title || row.userId })), truncated: rows.length > 200 }
  }
  async listChatChannels() {
    const rows = await this.store.destinations(false)
    return { items: rows.slice(0, 200).map(row => ({ id: row.id, name: row.title || 'Teams conversation', isMember: true })), truncated: rows.length > 200 }
  }
  async resolveDirectChat(userId: string) {
    const [dm] = await this.store.destinations(true, userId.toLowerCase())
    if (!dm) throw new Error('Ask the person to add the app in Teams and get the conversation approved in Gamut.')
    return dm.id
  }
  resolveRoute(event: IntegrationInputEvent) {
    const operation = teamsFileEvent.safeParse(event.payload)
    if (operation.success) return { externalId: event.externalId, action: 'run' as const, replyTarget: { respondentId: operation.data.senderId } }
    const route = super.resolveRoute(event)
    const message = incomingMessageSchema.parse(event.payload)
    return { ...route, replyTarget: { ...route.replyTarget, respondentId: message.userId } }
  }
  static parentChatId = teamsParentChatId
  static classifyChatId({ chatId }: ChatClassifyContext) {
    if (teamsParentChatId(chatId)) return 'thread' as const
    switch (teamsChatScope(chatId)) {
      case 'personal': return 'dm' as const
      case 'channel': return 'channel' as const
      case 'groupChat': return 'group' as const
    }
  }
  static generateSystemPrompt = () => 'You are chatting in Microsoft Teams. In channels and group chats people mention you on every turn. Keep replies in the conversation. You can receive and send files directly in a personal chat.'

  async connect() {
    if (this.socket) return this.socket.start()
    if (this.connected) return
    if (this.config.deliveryMode === 'socket') {
      const socket = createTeamsSocket(this.config, raw => this.acceptActivity(raw), error => {
        if (this.socket === socket) this.emitError(error)
      })
      this.socket = socket
      this.connected = true
      try { await socket.start() }
      catch (error) {
        if (this.socket === socket) await this.disconnect()
        throw error
      }
      return
    }
    this.connected = true
    const binding = this.config.relay
    if (!binding) return
    if (!this.host.relay) { this.connected = false; throw new Error('Teams webhook relay is unavailable') }
    this.relay = this.host.relay.attach(binding, async events => {
      const results = new Map<string, RelayAcceptResult>()
      for (const event of events) {
        if (!this.connected) { results.set(event.id, 'retry'); continue }
        const envelope = webhookEnvelopeSchema.safeParse(event.payload)
        if (event.endpointId !== binding.endpointId || !envelope.success || envelope.data.kind !== 'event' || !envelope.data.verified || !envelope.data.body) {
          results.set(event.id, 'discard'); continue
        }
        const { body, body_encoding } = envelope.data
        let raw: unknown
        try { raw = JSON.parse(Buffer.from(body, body_encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')) }
        catch { results.set(event.id, 'discard'); continue }
        const result = await this.acceptActivity(raw)
        results.set(event.id, typeof result === 'string' ? relayAcceptResult(result) : result.status >= 500 ? 'retry' : 'accepted')
      }
      return results
    })
  }
  async sessionsToRecover() {
    return this.references ? this.references.pendingRequestChats() : []
  }
  async disconnect() {
    this.connected = false
    const socket = this.socket
    this.socket = undefined
    await socket?.stop()
    this.relay?.detach()
    this.relay = undefined
    this.releaseAllAcknowledgements()
  }
  isConnected() {
    if (this.socket) return this.socket.isReady()
    return this.connected && (!this.relay || this.relay.isAttached())
  }
  activeTransport() { return this.isConnected() ? this.relay ? 'relay' as const : 'direct' as const : null }

  async acceptActivity(raw: unknown): Promise<IntegrationInputResult | InvokeResponse> {
    if (!this.connected) return 'retry'
    const parsed = teamsActivitySchema.safeParse(raw)
    if (!parsed.success || !matchesTeamsInstallation(parsed.data, this.config.tenantId, this.config.appId)) return 'rejected'
    const activity = parsed.data
    const eventType = activity.channelData?.eventType
    const appRemoved = activity.type === 'installationUpdate' && ['remove', 'remove-upgrade'].includes(activity.action ?? '')
    const removal = activity.type === 'conversationUpdate' && (eventType === 'teamDeleted' || eventType === 'channelDeleted' ||
      activity.membersRemoved?.some(m => sameTeamsApp(m.id, activity.recipient.id)))
    if (appRemoved || removal) {
      const teamId = eventType === 'channelDeleted' ? undefined : activity.channelData?.team?.id ?? activity.channelData?.teamsTeamId
      await this.store.uninstall(teamsScopeId(activity), teamId)
      return 'accepted'
    }
    if (!activity.from.aadObjectId || sameTeamsApp(activity.from.id, activity.recipient.id)) return 'rejected'
    if (activity.type === 'invoke') return this.invoke(activity)
    // Older Teams clients use the Action.Submit fallback, delivered as a message.
    if (activity.type === 'message' && activity.value != null) {
      const action = z.record(z.string(), z.unknown()).safeParse(activity.value)
      if (!action.success || typeof action.data.token !== 'string') return 'rejected'
      const response = await this.answer(activity, action.data)
      return response.body.statusCode === 200 ? 'accepted' : 'rejected'
    }
    const message = teamsIncomingMessage(activity)
    if (!message) return 'accepted'
    await this.store.remember(activity, message.userId)
    return this.emitMessage(message)
  }

  private async post(chatId: string, activity: Record<string, unknown>, replyTo?: string) {
    const ref = await this.store.reference(chatId)
    if (ref.threadRoot) return this.api.sendThreadActivity(ref.serviceUrl, ref.scopeId, ref.threadRoot, ref.conversationId, ref.scopeType, activity)
    return this.api.sendActivity(ref.serviceUrl, ref.conversationId, activity, replyTo)
  }
  private async edit(chatId: string, activityId: string, activity: Record<string, unknown>) {
    const ref = await this.store.reference(chatId)
    await this.api.updateActivity(ref.serviceUrl, ref.conversationId, activityId, activity)
  }
  async sendMessage(chatId: string, message: OutgoingMessage) {
    let id = ''
    for (const chunk of splitChatMessage(message.text, maxText)) id = await this.post(chatId, textActivity(chunk), message.replyToExternalId)
    return id
  }
  async sendStreamingUpdate(chatId: string, text: string, existingId?: string, replyTo?: string) {
    const partial = text.length > maxText ? text.slice(0, maxText - 1) + '…' : text
    if (!existingId) return this.post(chatId, textActivity(partial), replyTo)
    await this.edit(chatId, existingId, textActivity(partial))
    return existingId
  }
  async finalizeStreamingMessage(chatId: string, id: string, text: string) {
    const [first, ...rest] = splitChatMessage(text, maxText)
    await this.edit(chatId, id, textActivity(first))
    for (const chunk of rest) await this.post(chatId, textActivity(chunk))
  }
  async retireStreamingMessage(chatId: string, id: string) {
    const ref = await this.store.reference(chatId)
    await this.api.deleteActivity(ref.serviceUrl, ref.conversationId, id)
  }
  async startWorking(chatId: string) {
    const ref = await this.store.reference(chatId)
    await this.api.sendActivity(ref.serviceUrl, ref.conversationId, { type: 'typing' })
  }
  private async react(chatId: string, messageId: string, add: boolean) {
    if (add && !(await isChatAllowed(this.store.integrationId, chatId))) return
    const ref = await this.store.reference(chatId)
    await this.api.setReaction(ref.serviceUrl, ref.conversationId, messageId, '1f440_eyes', add)
  }
  protected addAcknowledgement(chatId: string, messageId: string) { return this.react(chatId, messageId, true) }
  protected removeAcknowledgement(chatId: string, messageId: string) { return this.react(chatId, messageId, false) }

  private async postCard(chatId: string, requestId: string | undefined, card: TeamsCard, render: (token: string) => Record<string, unknown>, respondentId?: string) {
    const token = randomUUID()
    const ref = await this.store.reference(chatId)
    await this.store.saveCard(chatId, token, requestId, card, respondentId ?? ref.originatorId)
    let id: string
    try { id = await this.post(chatId, render(token)) }
    catch (err) { await this.store.forget(token); throw err }
    await this.store.bindCard(token, id)
    return id
  }
  async sendUserRequestCard(chatId: string, event: UserRequestEvent, sessionId?: string, respondentId?: string) {
    if (event.type !== 'question_request') return this.sendMessage(chatId, { text: describeUnsupportedRequest(event, withSessionUrl(this.appLink, sessionId)) })
    const review = event.toolUseId.startsWith('review:')
    const card: TeamsCard = review ? { kind: 'review', question: event.questions[0].question } : { kind: 'question', questions: event.questions }
    return this.postCard(chatId, review ? event.toolUseId.split(':')[1] : event.toolUseId, card,
      token => cardActivity(teamsQuestionCard(token, card), review ? 'Permission request' : 'Question from your agent'), respondentId)
  }
  async sendFile(chatId: string, data: Buffer, filename: string, caption?: string, options?: SendFileOptions) {
    if (options?.asImage && !options.workspacePath) {
      const mime = guessMimeType(filename)
      const size = imageDimensions(data.subarray(0, 64 * 1024))
      if (!['image/png', 'image/jpeg', 'image/gif'].includes(mime) || data.length > 1024 * 1024 || !size || size.width > 1024 || size.height > 1024) {
        throw new Error('Image exceeds Teams inline image limits')
      }
      return this.post(chatId, { type: 'message', text: caption, attachments: [{ name: options.altText || filename, contentType: mime, contentUrl: `data:${mime};base64,${data.toString('base64')}` }] })
    }
    const path = options?.workspacePath
    if (!path || !this.record) throw new Error('Teams file delivery requires a workspace file')
    if (teamsChatScope(chatId) !== 'personal') {
      const base = resolveInternetAppBaseUrl()
      if (!base || !isAuthMode()) throw new Error('Open the file in Gamut or request a personal Teams delivery')
      const url = publicWorkspaceFileUrl(base, this.record.agentSlug, path, { inline: false })
      return this.post(chatId, cardActivity(adaptiveCard([{ type: 'TextBlock', text: caption || filename, wrap: true }],
        [{ type: 'Action.OpenUrl', title: 'Download in Gamut', url }]), filename))
    }
    if (!data.length) throw new Error('Teams cannot accept empty files')
    return this.postCard(chatId, undefined, { kind: 'file', path, filename, size: data.length, sha256: fileDigest(data) }, token => ({
      type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.teams.card.file.consent', name: filename,
        content: { description: caption || filename, sizeInBytes: data.length, acceptContext: { token }, declineContext: { token } } }],
    }))
  }

  private async currentCard(a: TeamsActivity, token: unknown): Promise<SavedCard | undefined> {
    if (typeof token !== 'string' || !z.string().uuid().safeParse(token).success) return
    const row = await this.store.card(token)
    if (!row?.activityId || row.respondentId !== a.from.aadObjectId?.toLowerCase() || (a.replyToId && a.replyToId !== row.activityId)) return
    const scope = teamsExternalId(a.conversation.conversationType, teamsScopeId(a))
    if ((teamsParentChatId(row.externalId) || row.externalId) !== scope) return
    const chain = a.channelData?.replyChain?.id || a.conversation.id.split(';messageid=')[1]
    if (chain && chain !== row.activityId && teamsExternalId(a.conversation.conversationType, teamsScopeId(a), chain) !== row.externalId) return
    if (!(await isChatAllowed(this.store.integrationId, row.externalId))) return
    return row
  }
  private async answer(a: TeamsActivity, data: Record<string, unknown>) {
    const row = await this.currentCard(a, data.token)
    if (!row?.requestId || row.card.kind === 'file') return adaptiveReply(400, 'This request is unavailable to this account.')
    const review = row.card.kind === 'review'
    const value = row.card.kind === 'question' ? teamsQuestionAnswers(row.card.questions, data)
      : data.answer === 'allow' || data.answer === 'deny' ? data.answer : undefined
    if (!value) return adaptiveReply(400, 'Select an answer for each question.')
    await this.emitEvent({ type: 'response', externalId: row.externalId, requestKind: review ? 'review' : 'input', requestId: row.requestId, value })
    return adaptiveReply(200, 'Response submitted.')
  }
  private async invoke(a: TeamsActivity): Promise<InvokeResponse> {
    if (a.name === 'adaptiveCard/action') {
      const action = executeAction.safeParse(a.value)
      return action.success ? this.answer(a, action.data.action.data) : adaptiveReply(400, 'Unknown card action.')
    }
    if (a.name !== 'fileConsent/invoke') return { status: 501 }
    const action = fileConsentAction.safeParse(a.value)
    if (!action.success) return { status: 400 }
    const row = await this.currentCard(a, action.data.context.token)
    if (!row || row.card.kind !== 'file') return { status: 403 }
    const { uploadInfo } = action.data
    if (action.data.action === 'accept' && (!uploadInfo || !isTeamsFileUrl(uploadInfo.uploadUrl) || !isTeamsFileUrl(uploadInfo.contentUrl))) return { status: 400 }
    // The inbox's unique event id makes accept and decline competing decisions.
    // Microsoft receives its invoke receipt as soon as the decision is durable.
    const result = await this.emitEvent({
      type: 'input', id: 'teams-file-consent:' + row.token, externalId: row.externalId, timestamp: new Date(),
      payload: teamsFileEvent.parse({ kind: 'teams.file-consent', senderId: row.respondentId, consent: action.data }),
    })
    return { status: result === 'retry' ? 503 : result === 'rejected' ? 403 : 200 }
  }

  async authorize(context: IntegrationSessionContext, event: IntegrationInputEvent) {
    return teamsFileEvent.safeParse(event.payload).success ? this.isAllowed(context) : super.authorize(context, event)
  }
  async acknowledgeInput(event: IntegrationInputEvent) {
    if (!teamsFileEvent.safeParse(event.payload).success) await super.acknowledgeInput(event)
  }
  async handleProviderInput(event: IntegrationInputEvent, context: IntegrationSessionContext, assertCurrent: () => void = () => {}) {
    const operation = teamsFileEvent.safeParse(event.payload)
    if (!operation.success) return false
    const { consent, senderId } = operation.data
    const row = await this.store.card(consent.context.token)
    if (!row?.activityId || row.card.kind !== 'file' || row.externalId !== context.externalId || row.respondentId !== senderId || !(await this.isAllowed(context))) return true
    assertCurrent()
    const card = row.card
    if (consent.action === 'decline') {
      await this.edit(row.externalId, row.activityId, textActivity(`File declined: ${card.filename}`))
    } else {
      const info = consent.uploadInfo
      if (!info || !isTeamsFileUrl(info.uploadUrl) || !isTeamsFileUrl(info.contentUrl)) throw new Error('Invalid Microsoft file destination')
      let uploaded = card.uploaded
      if (!uploaded) {
        const file = await agentRegistry.get(context.integration.agentSlug).files.getDoc(card.path)
        assertCurrent()
        if (!file || file.length !== card.size || fileDigest(Buffer.from(file)) !== card.sha256) {
          await this.edit(row.externalId, row.activityId, textActivity(`The file ${card.filename} changed. Ask the agent to share a new copy.`))
          await this.store.forget(row.token)
          return true
        }
        if (!(await this.isAllowed(context))) return true
        assertCurrent()
        await uploadTeamsFile(info.uploadUrl, Buffer.from(file))
        uploaded = { uniqueId: info.uniqueId, fileType: info.fileType, contentUrl: info.contentUrl }
        if (!(await this.store.updateCardPayload(row.token, row.payload, { ...card, uploaded }))) return true
      }
      assertCurrent()
      await this.edit(row.externalId, row.activityId, { type: 'message', attachments: [{
        name: card.filename, contentType: 'application/vnd.microsoft.teams.card.file.info', contentUrl: uploaded.contentUrl,
        content: { uniqueId: uploaded.uniqueId, fileType: uploaded.fileType },
      }] })
    }
    await this.store.forget(row.token)
    return true
  }
  private async closeCards(chatId: string, message: string, requestId?: string) {
    for (const row of await this.store.requestCards(chatId, requestId)) {
      if (!row.requestId || !row.activityId) continue
      await this.edit(chatId, row.activityId, cardActivity(adaptiveCard([{ type: 'TextBlock', text: message, wrap: true }]), message))
      await this.store.forget(row.token)
    }
  }
  async dismissOpenCards(chatId: string) { await this.closeCards(chatId, 'Request closed.') }
  async deliver(context: IntegrationSessionContext, output: IntegrationOutput) {
    if (output.type === 'request-settled' && output.requestId) {
      await this.closeCards(context.externalId, 'This request was already handled.', output.requestId)
      return
    }
    if (output.type === 'request-resolved') {
      const review = output.kind === 'proxy_review' || output.kind === 'x_agent_review'
      const status = review && output.outcome === 'answered' ? 'Approved' : review && output.outcome === 'declined' ? 'Denied'
        : output.outcome === 'timeout' ? 'Request expired' : `Request ${output.outcome}`
      await this.closeCards(context.externalId, status + '.', output.requestId)
      return
    }
    await super.deliver(context, output)
  }
}
