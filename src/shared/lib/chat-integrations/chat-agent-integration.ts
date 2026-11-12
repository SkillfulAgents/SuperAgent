/**
 * ChatAgentIntegration — abstract base class for external chat integrations.
 *
 * Each provider (Telegram, Slack, etc.) extends this class and implements
 * the platform-specific connection, messaging, and interactive response logic.
 */

import { AgentIntegration } from '../agent-integrations/agent-integration'
import { THREAD_NAME_SEPARATOR } from '../agent-integrations/presentation'
import type { AgentIntegrationRecord, AgentIntegrationDefinition, IntegrationInputEvent, IntegrationInputContext, IntegrationInputResult, IntegrationRoute, IntegrationSessionContext, IntegrationSessionPolicy, IntegrationOutput, IntegrationTool, PreparedIntegrationInput } from '../agent-integrations/types'
import { ChatInputBuilder } from './chat-input'
import { BUSY_ACTIVITIES, armIndicatorIfBusy, clearIndicator, stopIndicatorTick, processSSEEvent, deriveDisplayName, isDisplayNameFallback, deliverMarkdown, UndeliveredMessageError, type ManagedConnector } from './chat-delivery'
import { decideInboundAccess, getChatAccess, markNoticeSent } from '../services/chat-integration-access-service'
import { consumeOrCancelAwaitingInput } from './resolve-awaiting-input'
import { reviewCardFromRegistry } from './request-card'
import { chatDefinitions } from './definitions'
import { chatIntegrationPolicy, chatSettings } from './chat-policy'
import { z } from 'zod'
import type { UserRequestEvent } from '@shared/lib/tools/types'
import type { SessionActivity } from '@shared/lib/types/agent'

export type ToolOutcome = 'success' | 'error' | 'cancelled'
import type { ChatProvider } from './config-schema'
import { incomingMessageSchema } from './message-schema'
import { captureException } from '@shared/lib/error-reporting'
import { background } from '@shared/lib/background'
import {
  INTEGRATION_MESSAGE_LIMITS, clampIntegrationText, integrationTimestamp, safeIntegrationLink,
  type IntegrationMessagePresentation, type IntegrationMessageSource,
} from '../agent-integrations/message-display-schema'

// ── Types ───────────────────────────────────────────────────────────────

export interface IncomingMessage {
  externalMessageId: string    // Platform-specific ID (Telegram message_id, unique per chat; Slack message ts)
  text: string
  chatId: string               // Telegram chat_id or Slack channel_id
  userId: string               // Telegram user_id or Slack user_id
  chatType?: 'private' | 'group' | 'supergroup'  // Telegram chat type (undefined for non-Telegram connectors)
  userName?: string            // Display name of the user (for session naming)
  chatName?: string            // Display name of the chat/channel (for session naming)
  files?: { name: string; url: string; mimeType?: string }[]
  timestamp: Date
  /** Shown in the app only; never part of the agent's input. Links must be public https. */
  display?: ChatMessageDisplayHints
}

/** Provider extras for the app's message card. */
export interface ChatMessageDisplayHints {
  /** What the person wrote, when `text` also carries injected context (earlier thread messages). */
  requestText?: string
  avatarUrl?: string
  messageUrl?: string
  conversationUrl?: string
  workspace?: string
}

export interface OutgoingMessage {
  text: string
  parseMode?: 'html' | 'markdown'
  replyToExternalId?: string
  /** A thread reply that also shows in the channel ("Also send to channel"). */
  alsoSendToChannel?: boolean
}

/** Context available at chat-session creation, passed to generateSystemPrompt. */
export type SystemPromptContext = Pick<IncomingMessage, 'chatId' | 'chatName' | 'userName'>

/** What a connector's chat classifier gets to look at. */
export type ChatClassifyContext = Pick<IncomingMessage, 'chatId' | 'chatName'>

/** What kind of conversation a chat addresses, for labeling and attribution. */
export type ChatConversationType = 'dm' | 'channel' | 'group' | 'thread'

/**
 * Whether more than one person can post. Fail-closed: only group/channel/thread
 * count; undefined (unclassified) does not.
 */
export function isMultiPartyChatType(type: ChatConversationType | undefined): boolean {
  return type === 'group' || type === 'channel' || type === 'thread'
}

/**
 * The message a reply quotes: the oldest one not yet answered, unless the reply lands reliably
 * right under it (a 1:1, the only one unanswered, and still the chat's latest message).
 */
export function quotedMessageId(unanswered: string[], multiParty: boolean, latest: string | undefined): string | undefined {
  return multiParty || unanswered.length > 1 || latest !== unanswered[0] ? unanswered[0] : undefined
}

/** What a chat's replies need to know to quote, kept while the chat has messages waiting. */
interface QuoteState {
  multiParty: boolean
  /** The chat's latest message, while nothing has been posted after it. */
  latest?: string
  /** Waiting messages a finished turn already answered. */
  answered: Set<string>
  /** The chat message behind each delivery, since a turn names the deliveries it answered. */
  deliveries: Map<string, string>
}

/** Optional discovery features a provider can support (see discoveryCapabilities). */
export type ChatDiscoveryCapability = 'list_users' | 'list_channels' | 'dm_by_user_id'

/** A person reachable through a provider's directory. */
export interface ChatDirectoryUser {
  id: string
  name: string
  title?: string
}

/** A channel/group the bot could post into. */
export interface ChatDirectoryChannel {
  id: string
  name: string
  isPrivate?: boolean
  /** Whether the bot is a member (it may be unable to post where it isn't). */
  isMember?: boolean
}

/**
 * A capped directory listing. `truncated` is true when the provider had more
 * entries than the cap — callers must surface that rather than presenting the
 * list as complete.
 */
export interface ChatDirectoryPage<T> {
  items: T[]
  truncated: boolean
}

/**
 * Static surface of a connector class, for capability lookups that never
 * construct (concrete connectors have provider-specific constructor args, so
 * `typeof ChatAgentIntegration` — which carries a construct signature — would
 * not admit them).
 */
export type ChatConnectorClass = Pick<
  typeof ChatAgentIntegration,
  'generateSystemPrompt' | 'discoveryCapabilities' | 'classifyChatId' | 'parentChatId'
>

const CHAT_EVENT_LABELS: Record<IntegrationMessageSource['kind'], string> = {
  direct: 'Direct message',
  group: 'Group message',
  channel: 'Channel message',
  thread: 'Thread reply',
  task: 'Message',
}

// ── Abstract class ──────────────────────────────────────────────────────

export interface SendFileOptions { asImage?: boolean; alsoSendToChannel?: boolean; altText?: string; deadline?: number }

// The agent waits on send_message, and on the cloud runtime agent-to-host requests are cut at 30 s
// while the host carries on, so the agent would retry and post twice. It gets its answer by this budget.
const SEND_MESSAGE_BUDGET_MS = 20_000

export abstract class ChatAgentIntegration extends AgentIntegration {
  abstract readonly provider: ChatProvider

  /**
   * Optional provider-specific system prompt attached to every NEW chat
   * session for this provider. Implement it to tell the agent what kind of
   * conversation it is serving (e.g. Slack DM vs channel thread) and any
   * provider conventions (delivery semantics, reaction tags, …).
   *
   * Static rather than an instance method: the prompt derives from the
   * incoming message alone and must not depend on live connection state.
   */
  static generateSystemPrompt?: (message: SystemPromptContext) => string

  /**
   * Discovery features this provider supports, advertised to agents via
   * list_agent_integrations so tools that need a capability are only ever
   * suggested where it exists. Static (a property of the provider, not a
   * connection) so listings can label integrations without a live connector.
   * Undefined/empty means no discovery support — the graceful default.
   */
  static discoveryCapabilities?: ReadonlyArray<ChatDiscoveryCapability>

  /**
   * Classify a chat as dm/channel/group/thread. Each provider uses its best
   * signal (Slack/Telegram: id shape; iMessage: chatName when the bridge set
   * one). Optional: providers that cannot classify leave chats unlabeled.
   * Static for the same reason generateSystemPrompt is: it derives from the
   * message alone. Listing callers may pass only chatId.
   */
  static classifyChatId?: (chat: ChatClassifyContext) => ChatConversationType | undefined

  /** The chat a thread id belongs to (a Slack thread's channel), or undefined when the id is not a thread. */
  static parentChatId?: (chatId: string) => string | undefined

  /**
   * List people reachable through the provider's directory (capability:
   * list_users). Implementations must cap the result and set `truncated`
   * rather than returning unbounded listings from large workspaces.
   */
  listChatUsers?(): Promise<ChatDirectoryPage<ChatDirectoryUser>>

  /** List channels/groups the bot could post into (capability: list_channels). */
  listChatChannels?(): Promise<ChatDirectoryPage<ChatDirectoryChannel>>

  /**
   * Return (opening if needed) the chat id of a 1:1 conversation with a
   * directory user (capability: dm_by_user_id). Lets a send reach a person the
   * bot has never talked to. Throws when the provider refuses (e.g. the user
   * left the workspace).
   */
  resolveDirectChat?(userId: string): Promise<string>

  /** Establish connection (long-poll loop / WebSocket). Resolves once healthy. */
  abstract connect(): Promise<void>

  /** Tear down connection gracefully. */
  abstract disconnect(): Promise<void>

  /** Send a text message (final, complete). Returns external message ID. */
  abstract sendMessage(chatId: string, message: OutgoingMessage): Promise<string>

  /**
   * Streaming: send or update a "draft" message with partial content.
   * First call (no existingMessageId) creates the message.
   * Subsequent calls edit the existing message.
   * Returns the external message ID.
   */
  abstract sendStreamingUpdate(chatId: string, text: string, existingMessageId?: string, replyToExternalId?: string): Promise<string>

  /** Finalize a streaming message (last edit with final text). */
  abstract finalizeStreamingMessage(chatId: string, messageId: string, finalText: string, replyToExternalId?: string): Promise<void>

  /**
   * Remove a streamed draft that no text replaces: the reply opened with an image.
   * Default no-op for connectors that show no draft.
   */
  async retireStreamingMessage(_chatId: string, _messageId: string): Promise<void> {}

  /**
   * Signal that the agent is busy, labeled by what it is doing (`activity`). The
   * connector owns how that maps to its surface (Telegram labels a draft, Slack
   * sets its status line) AND any keep-alive needed to survive provider-side
   * expiry. Called
   * again with a new activity when the label changes mid-turn. Idempotent — safe
   * to call repeatedly for the same chat.
   */
  abstract startWorking(chatId: string, activity: SessionActivity): Promise<void>

  /**
   * Stop the working indicator as the response takes over. Idempotent — safe to
   * call repeatedly. Default no-op for connectors whose indicator is ephemeral
   * and self-expires.
   */
  async stopWorking(_chatId: string): Promise<void> {}

  /** Mark an incoming message as received, before the agent starts. Default no-op. */
  protected async addAcknowledgement(_chatId: string, _messageId: string): Promise<void> {}

  /** Take the received mark off a message. Default no-op. */
  protected async removeAcknowledgement(_chatId: string, _messageId: string): Promise<void> {}

  /**
   * Send a file to the chat. Returns the external message ID. Throws when the file did not arrive.
   * @param chatId Target chat/channel
   * @param fileData Buffer of the file content
   * @param filename Display name for the file
   * @param caption Optional text caption to accompany the file
   * @param options.asImage Show it as an image in the reply, not as the original file
   * @param options.alsoSendToChannel Broadcast it from a thread to its channel, as the message's text is
   * @param options.altText The image's description, where the platform shows one
   * @param options.deadline When to stop waiting on the platform (epoch ms), past which the send fails
   */
  abstract sendFile(chatId: string, fileData: Buffer, filename: string, caption?: string, options?: SendFileOptions): Promise<string>

  /**
   * Send a rich card for user-request items.
   * Each connector pattern-matches on event.type and renders natively
   * (Slack Block Kit, Telegram inline keyboards, etc.).
   * Returns the external message ID.
   */
  abstract sendUserRequestCard(chatId: string, event: UserRequestEvent, sessionId?: string): Promise<string>

  /**
   * A tool call starts. Default: post its pill text and return that message, which
   * {@link showToolOutcome} later edits. A connector with its own tool display overrides both.
   */
  async showToolStart(chatId: string, _tool: { toolUseId: string; toolName: string; summary: string }, pillText: string): Promise<string> {
    return this.sendMessage(chatId, { text: pillText })
  }

  /** A tool call ends. Default: edit its pill to show the outcome. */
  async showToolOutcome(chatId: string, _toolUseId: string, _outcome: ToolOutcome, pillText: string, messageId: string): Promise<void> {
    await this.sendStreamingUpdate(chatId, pillText, messageId)
  }

  /**
   * Resolve an open single-question AskUserQuestion card with a free-typed message as the
   * "Other" answer. Returns true only if a live card matching `toolUseId` is open for this chat,
   * so the manager consumes the message only on a real resolve. Default: not supported (false).
   */
  async answerOpenQuestionWithText(_chatId: string, _toolUseId: string, _text: string): Promise<boolean> {
    return false
  }

  /**
   * Dismiss every open request card for this chat: strip its inline keyboard and forget its
   * callbacks, so a card abandoned by a cancelling message doesn't keep showing live buttons.
   * Called on the cancel path when a new message starts a fresh turn. Default no-op for
   * connectors without interactive cards.
   */
  async dismissOpenCards(_chatId: string): Promise<void> {}

  /** Whether the connection is healthy right now. */
  abstract isConnected(): boolean

  // Shared chat policy. The application consumes only the AgentIntegration hooks.
  private deliverySessions = new Map<string, ManagedConnector>()
  private acknowledgements = new Map<string, string[]>()
  private quoteStates = new Map<string, QuoteState>()
  // When the agent last posted in each chat. A message sent before then landed above that post,
  // even when it reaches the host after it. Outlives the waiting list, since that can empty in between.
  private lastPosts = new Map<string, number>()
  private static readonly MAX_LAST_POSTS = 1000
  private inputBuilder = new ChatInputBuilder(async () => this.constructor as ChatConnectorClass)

  get definition(): AgentIntegrationDefinition {
    return chatDefinitions[this.provider]
  }

  resolveRoute(event: IntegrationInputEvent): IntegrationRoute {
    const message = incomingMessageSchema.parse(event.payload)
    let displayName = deriveDisplayName(message)
    if (message.chatId.includes('|')) {
      const date = message.timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      const time = message.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      displayName = displayName ? `${displayName}${THREAD_NAME_SEPARATOR}${date}, ${time}` : `${date}, ${time}`
    }
    const command = message.text.trim().toLowerCase()
    return {
      externalId: message.chatId, displayName, interactionId: event.id,
      replyTarget: { chatId: message.chatId },
      action: command === '/clear' ? 'reset' : this.provider === 'telegram' && command === '/start' ? 'ignore' : 'run',
      ...(this.provider === 'telegram' && command === '/start' ? { notice: "You're connected. Send a message to start." } : {}),
    }
  }

  async authorize(context: IntegrationSessionContext, event: IntegrationInputEvent): Promise<boolean> {
    const message = incomingMessageSchema.parse(event.payload)
    const integrationId = context.integration.id
    const chatId = context.externalId
    const decision = await decideInboundAccess({ integrationId, externalChatId: chatId, chatType: message.chatType,
      userId: message.userId, userName: message.userName, chatName: message.chatName, preview: message.text })
    if (decision.action !== 'blocked') return true
    this.releaseAcknowledgements(chatId, [message.externalMessageId])
    if (decision.sendNotice) {
      const access = await getChatAccess(integrationId, chatId)
      if (access) {
        try {
          await this.sendMessage(chatId, { text: 'This bot needs the owner to approve this conversation before it can respond.' })
          await markNoticeSent(access.id)
        } catch (error) {
          captureException(error, { tags: { component: 'chat-integration', operation: 'access-notice' }, level: 'warning' })
        }
      }
    }
    return false
  }

  isAllowed(context: IntegrationSessionContext): Promise<boolean> {
    return chatIntegrationPolicy.isAllowed(context)
  }

  sessionPolicy(integration: AgentIntegrationRecord, route: Partial<IntegrationRoute>): IntegrationSessionPolicy {
    return chatIntegrationPolicy.sessionPolicy(integration, route)
  }

  shouldUpdateDisplayName(current: string | null | undefined): boolean {
    return isDisplayNameFallback(current)
  }

  async prepareInput(event: IntegrationInputEvent, context: IntegrationInputContext): Promise<PreparedIntegrationInput> {
    const message = incomingMessageSchema.parse(event.payload)
    const { text, failedFiles, request } = await this.inputBuilder.buildMessageContent(context.integration, message)
    const skip = failedFiles.length > 0 && !text.trim()
    if (skip) this.releaseAcknowledgements(context.externalId, [message.externalMessageId])
    else if (context.deliveryId) this.quoteStates.get(context.externalId)?.deliveries.set(context.deliveryId, message.externalMessageId)
    if (failedFiles.length && (await this.isAllowed(context))) {
      await this.sendMessage(context.externalId, { text: `Could not download file(s): ${failedFiles.join(', ')}. ${skip ? 'Message was not sent to the agent.' : 'Your text message will still be sent.'}\n\nIf this is a Slack bot, ensure the \`files:read\` scope is added and the app is reinstalled.` })
    }
    return { text, skip, systemPrompt: (this.constructor as ChatConnectorClass).generateSystemPrompt?.(message), display: this.describeMessage(message, request) }
  }

  /** The app's card for an incoming chat message: who wrote what, where. */
  protected describeMessage(message: IncomingMessage, request: string): IntegrationMessagePresentation {
    const conversation = (this.constructor as ChatConnectorClass).classifyChatId?.(message)
    const kind = !conversation || conversation === 'dm' ? 'direct' : conversation
    const hints = message.display
    const author = message.userName || message.userId
    return {
      event: { type: 'message', label: CHAT_EVENT_LABELS[kind] },
      request: {
        text: clampIntegrationText(request, INTEGRATION_MESSAGE_LIMITS.requestText),
        ...(author ? { author: { name: clampIntegrationText(author, INTEGRATION_MESSAGE_LIMITS.name), avatarUrl: safeIntegrationLink(hints?.avatarUrl) } } : {}),
        sentAt: integrationTimestamp(message.timestamp),
        url: safeIntegrationLink(hints?.messageUrl),
      },
      source: {
        kind,
        title: message.chatName ? clampIntegrationText(message.chatName, INTEGRATION_MESSAGE_LIMITS.label) : undefined,
        url: safeIntegrationLink(hints?.conversationUrl),
        workspace: hints?.workspace ? clampIntegrationText(hints.workspace, INTEGRATION_MESSAGE_LIMITS.label) : undefined,
      },
    }
  }

  async acknowledgeInput(event: IntegrationInputEvent): Promise<void> {
    if (this.resolveRoute(event).action !== 'run') return
    const message = incomingMessageSchema.parse(event.payload)
    const { chatId, externalMessageId: messageId } = message
    const state: QuoteState = this.quoteStates.get(chatId) ?? { multiParty: false, answered: new Set(), deliveries: new Map() }
    state.multiParty ||= isMultiPartyChatType((this.constructor as ChatConnectorClass).classifyChatId?.(message))
    if (message.timestamp.getTime() > (this.lastPosts.get(chatId) ?? 0)) state.latest = messageId
    this.quoteStates.set(chatId, state)
    const marks = this.acknowledgements.get(chatId)
    if (marks) marks.push(messageId)
    else this.acknowledgements.set(chatId, [messageId])
    await this.addAcknowledgement(chatId, messageId)
    if (!this.acknowledgements.get(chatId)?.includes(messageId)) {
      await this.removeAcknowledgement(chatId, messageId).catch(() => {})
    }
  }

  acknowledgedMessages(chatId: string): string[] {
    return [...(this.acknowledgements.get(chatId) ?? [])]
  }

  /** Whether a reply shows text, so it can carry a quote. */
  carriesText(_chatId: string, text: string): boolean {
    return text.trim() !== ''
  }

  /** The message a reply in this chat quotes. Connectors that cannot quote ignore it. */
  quotedMessage(chatId: string): string | undefined {
    const state = this.quoteStates.get(chatId)
    if (!state) return undefined
    const unanswered = this.acknowledgedMessages(chatId).filter(id => !state.answered.has(id))
    return quotedMessageId(unanswered, state.multiParty, state.latest)
  }

  /** The agent posted in the chat, so no waiting message is its latest any more. */
  messagePosted(chatId: string): void {
    const state = this.quoteStates.get(chatId)
    if (state) state.latest = undefined
    this.lastPosts.delete(chatId)
    this.lastPosts.set(chatId, Date.now())
    // Only recent posts matter: keep the most recently active chats.
    for (const oldest of this.lastPosts.keys()) {
      if (this.lastPosts.size <= ChatAgentIntegration.MAX_LAST_POSTS) break
      this.lastPosts.delete(oldest)
    }
  }

  /** A turn finished, naming the deliveries it answered. */
  markAnswered(chatId: string, deliveryIds: string[]): void {
    const state = this.quoteStates.get(chatId)
    for (const id of deliveryIds) {
      const messageId = state?.deliveries.get(id)
      if (!state || !messageId) continue
      state.answered.add(messageId)
      state.deliveries.delete(id)
    }
  }

  releaseAcknowledgements(chatId: string, messageIds = this.acknowledgedMessages(chatId)): void {
    const remaining = (this.acknowledgements.get(chatId) ?? []).filter(id => !messageIds.includes(id))
    if (remaining.length) this.acknowledgements.set(chatId, remaining)
    else {
      this.acknowledgements.delete(chatId)
      this.quoteStates.delete(chatId)
    }
    for (const messageId of messageIds) {
      background(this.removeAcknowledgement(chatId, messageId).catch(() => {}), { name: 'chat-integration.remove-acknowledgement' })
    }
  }

  protected releaseAllAcknowledgements(): void {
    for (const chatId of [...this.acknowledgements.keys()]) this.releaseAcknowledgements(chatId)
    this.lastPosts.clear()
  }

  async consumeInput(event: IntegrationInputEvent, context: IntegrationInputContext, input: PreparedIntegrationInput): Promise<boolean> {
    if (!context.sessionId) return false
    const message = incomingMessageSchema.parse(event.payload)
    const { actor } = context
    const { sessionId } = context
    return consumeOrCancelAwaitingInput({
      chatId: context.externalId, messageText: input.text, answerText: message.text, hasFiles: !!message.files?.length,
      session: {
        live: () => actor.sessions.live(sessionId),
        cancelAwaiting: () => actor.inputs.cancelAwaiting(sessionId),
      },
      connector: this,
    })
  }

  private deliveryState(context: IntegrationSessionContext): ManagedConnector {
    const key = context.externalId
    let state = this.deliverySessions.get(key)
    if (state && state.sessionId !== context.sessionId) {
      this.releaseSession({ ...context, sessionId: state.sessionId })
      state = undefined
    }
    if (!state) {
      state = { connector: this, integration: context.integration, chatId: key, sessionId: context.sessionId,
        streamingState: { currentMessageId: null, accumulatedText: '', lastUpdateTime: 0 }, currentToolInput: '', pendingToolMessages: [] }
      this.deliverySessions.set(key, state)
    }
    state.integration = context.integration
    return state
  }

  async deliver(context: IntegrationSessionContext, output: IntegrationOutput): Promise<void> {
    if (output.type === 'message') { await this.sendMessage(context.externalId, { text: output.text }); return }
    if (output.type === 'session-reset') { await this.sendMessage(context.externalId, { text: '🗑️ Session cleared. Your next message will start a fresh conversation.' }); return }
    if (output.type === 'access-approved') { await this.sendMessage(context.externalId, { text: "You're approved. Send a message to start." }); return }
    if (output.type === 'request-settled') { await this.sendMessage(context.externalId, { text: 'That request was already handled — this card is no longer waiting on you.' }); return }
    if (output.type === 'request-opened') {
      if (output.request.scope.sessionId) {
        await processSSEEvent(this.deliveryState(context), { type: 'user_request_created', request: output.request }, chatSettings(context.integration).showToolCalls, context.sessionId)
      }
      const card = reviewCardFromRegistry(output.request)
      if (!card) return
      const marks = this.acknowledgedMessages(context.externalId)
      await this.sendUserRequestCard(context.externalId, card, context.sessionId)
      this.releaseAcknowledgements(context.externalId, marks)
      return
    }
    const state = this.deliveryState(context)
    if (output.type === 'turn-started') { state.turnNotified = false; return }
    if (output.type !== 'runtime' && output.type !== 'turn-completed' && output.type !== 'turn-failed') return
    await processSSEEvent(state, output.event, chatSettings(context.integration).showToolCalls, context.sessionId ?? '')
  }

  // The working indicator is armed from what the session is doing.
  override readonly observesActivity = true
  observeSession(context: IntegrationSessionContext): void {
    if (!context.sessionId) return
    const state = this.deliveryState(context)
    const activity = context.activity
    if (!activity || activity === 'unknown') return
    armIndicatorIfBusy(state, context.sessionId, activity)
    if (!BUSY_ACTIVITIES.has(activity)) clearIndicator(state)
  }

  releaseSession(context: IntegrationSessionContext): void {
    const state = this.deliverySessions.get(context.externalId)
    if (!state || (context.sessionId && state.sessionId !== context.sessionId)) return
    stopIndicatorTick(state)
    background(this.stopWorking(context.externalId).catch(() => {}), { name: 'chat-integration.stop-working' })
    this.deliverySessions.delete(context.externalId)
  }

  getTools(context: IntegrationSessionContext): readonly IntegrationTool[] {
    const stringArgument = (input: unknown, key: string) => z.object({ [key]: z.string().min(1) }).parse(input)[key]
    const tool = (name: string, description: string, properties: Record<string, unknown>, execute: IntegrationTool['execute']): IntegrationTool => ({
      name, description, inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }, execute,
    })
    const tools = [tool('send_message', 'Send a complete message to an external conversation.', { text: { type: 'string' }, alsoSendToChannel: { type: 'boolean' } }, async input => {
      if (!(await this.isAllowed(context))) throw new Error('Conversation is not allowed')
      const deadline = Date.now() + SEND_MESSAGE_BUDGET_MS
      const { text, alsoSendToChannel } = z.object({ text: z.string().min(1), alsoSendToChannel: z.boolean() }).parse(input)
      await this.startWorking(context.externalId, 'working').catch(() => {})
      try {
        await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 1100))
        if (!(await this.isAllowed(context))) throw new Error('Conversation is not allowed')
        const delivery = deliverMarkdown(this, context.integration.agentSlug, context.externalId, text, { alsoSendToChannel, deadline })
        let timer: ReturnType<typeof setTimeout> | undefined
        const outOfTime = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), deadline - Date.now()) })
        const delivered = await Promise.race([delivery, outOfTime]).finally(() => clearTimeout(timer))
        if (!delivered) {
          // The agent gets its answer within the budget. A post still in flight finishes behind it, and a failure there is reported.
          background(delivery.then(({ undelivered, error }) => { if (undelivered.length) throw error }), { name: 'chat-integration.send-message-tail' })
          return ''
        }
        const { messageId, undelivered, error } = delivered
        if (undelivered.length) throw new UndeliveredMessageError(undelivered, error)
        return messageId
      } finally { await this.stopWorking(context.externalId).catch(() => {}) }
    })]
    if (this.listChatUsers) tools.push(tool('list_users', 'List reachable people.', {}, () => this.listChatUsers!()))
    if (this.listChatChannels) tools.push(tool('list_channels', 'List reachable channels.', {}, () => this.listChatChannels!()))
    if (this.resolveDirectChat) tools.push(tool('dm_by_user_id', 'Resolve a direct conversation.', { userId: { type: 'string' } }, input => this.resolveDirectChat!(stringArgument(input, 'userId'))))
    return tools
  }

  // ── Protected helpers for subclasses ────────────────────────────────

  /**
   * Hands a message to the host and resolves to what it did with it, for
   * transports that acknowledge or redeliver. A handler failure resolves
   * `retry`: the manager reports it, and it does not imply the provider
   * transport is unhealthy (it must not flip its connection status).
   */
  protected emitMessage(message: IncomingMessage): Promise<IntegrationInputResult> {
    return this.emitEvent({ type: 'input', id: message.externalMessageId, externalId: message.chatId, timestamp: message.timestamp, payload: message })
      .catch((): IntegrationInputResult => 'retry')
  }

  protected emitInteractiveResponse(toolUseId: string, response: unknown, chatId?: string): void {
    const review = toolUseId.startsWith('review:')
    const value = response as { answer?: string; question?: string; answers?: Record<string, string> } | undefined
    background(this.emitEvent({
      type: 'response', externalId: chatId ?? '',
      requestId: review ? toolUseId.split(':')[1] : toolUseId,
      requestKind: review ? 'review' : 'input',
      value: review ? (value?.answer?.toLowerCase().includes('allow') ? 'allow' : 'deny')
        : value?.question && value.answer !== undefined ? value.answers ?? { [value.question]: value.answer } : response,
    }).catch(error => this.emitError(error instanceof Error ? error : new Error(String(error)))), { name: 'chat-integration.interactive-response' })
  }

  protected emitTypingHint(chatId: string): void {
    background(this.emitEvent({ type: 'hint', externalId: chatId }).catch(() => {}), { name: 'chat-integration.typing-hint' })
  }
}
