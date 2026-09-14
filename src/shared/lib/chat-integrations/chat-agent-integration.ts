/**
 * ChatAgentIntegration — abstract base class for external chat integrations.
 *
 * Each provider (Telegram, Slack, etc.) extends this class and implements
 * the platform-specific connection, messaging, and interactive response logic.
 */

import { AgentIntegration } from '../agent-integrations/agent-integration'
import type { AgentIntegrationRecord, AgentIntegrationDefinition, IntegrationInputEvent, IntegrationInputContext, IntegrationRoute, IntegrationSessionContext, IntegrationSessionPolicy, IntegrationOutput, IntegrationTool, PreparedIntegrationInput } from '../agent-integrations/types'
import { ChatInputBuilder } from './chat-input'
import { BUSY_ACTIVITIES, armIndicatorIfBusy, clearIndicator, stopIndicatorTick, processSSEEvent, buildSessionName, deriveDisplayName, isDisplayNameFallback, type ManagedConnector } from './chat-delivery'
import { agentRegistry } from '../agent-actor'
import { decideInboundAccess, isChatAllowed, getChatAccess, markNoticeSent } from '../services/chat-integration-access-service'
import { consumeOrCancelAwaitingInput } from './resolve-awaiting-input'
import { reviewCardFromRegistry } from './request-card'
import { chatDefinitions } from './definitions'
import { z } from 'zod'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import type { SessionActivity } from '@shared/lib/types/agent'
import type { ChatProvider } from './config-schema'
import { captureException } from '@shared/lib/error-reporting'

// ── Types ───────────────────────────────────────────────────────────────

export type ChatIntegrationStatus = 'active' | 'paused' | 'error' | 'disconnected'

export interface IncomingMessage {
  externalMessageId: string    // Platform-specific ID (Telegram update_id, Slack message ts)
  text: string
  chatId: string               // Telegram chat_id or Slack channel_id
  userId: string               // Telegram user_id or Slack user_id
  chatType?: 'private' | 'group' | 'supergroup'  // Telegram chat type (undefined for non-Telegram connectors)
  userName?: string            // Display name of the user (for session naming)
  chatName?: string            // Display name of the chat/channel (for session naming)
  files?: { name: string; url: string; mimeType?: string }[]
  timestamp: Date
}

export interface OutgoingMessage {
  text: string
  parseMode?: 'html' | 'markdown'
  replyToExternalId?: string
}

export type MessageHandler = (message: IncomingMessage) => void
export type InteractiveResponseHandler = (toolUseId: string, response: unknown, chatId?: string) => void
export type ErrorHandler = (error: Error) => void
export type TypingHintHandler = (chatId: string) => void

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
  'generateSystemPrompt' | 'discoveryCapabilities' | 'classifyChatId'
>

// Read both the existing database columns and an explicit family settings envelope.
const chatSettingsSchema = z.object({ showToolCalls: z.boolean().default(false), sessionTimeout: z.number().nullable().default(null) })
function chatSettings(integration: AgentIntegrationRecord) {
  return chatSettingsSchema.parse(integration.settings ?? integration)
}

// ── Abstract class ──────────────────────────────────────────────────────

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
   * list_chat_integrations so tools that need a capability are only ever
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

  protected messageHandlers: MessageHandler[] = []
  protected interactiveResponseHandlers: InteractiveResponseHandler[] = []
  protected typingHintHandlers: TypingHintHandler[] = []

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
  abstract sendStreamingUpdate(chatId: string, text: string, existingMessageId?: string): Promise<string>

  /** Finalize a streaming message (last edit with final text). */
  abstract finalizeStreamingMessage(chatId: string, messageId: string, finalText: string): Promise<void>

  /**
   * Signal that the agent is busy, labeled by what it is doing (`activity`). The
   * connector owns how that maps to its surface (Telegram labels a draft, Slack
   * reacts) AND any keep-alive needed to survive provider-side expiry. Called
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

  /**
   * Send a file to the chat. Returns the external message ID.
   * @param chatId Target chat/channel
   * @param fileData Buffer of the file content
   * @param filename Display name for the file
   * @param caption Optional text caption to accompany the file
   */
  abstract sendFile(chatId: string, fileData: Buffer, filename: string, caption?: string): Promise<string>

  /**
   * Send a rich card for user-request items.
   * Each connector pattern-matches on event.type and renders natively
   * (Slack Block Kit, Telegram inline keyboards, etc.).
   * Returns the external message ID.
   */
  abstract sendUserRequestCard(chatId: string, event: UserRequestEvent, sessionId?: string): Promise<string>

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
  private inputBuilder = new ChatInputBuilder(async () => this.constructor as ChatConnectorClass)

  get definition(): AgentIntegrationDefinition {
    return chatDefinitions[this.provider]
  }

  describeTarget(externalId: string): { type?: ChatConversationType } {
    return { type: (this.constructor as ChatConnectorClass).classifyChatId?.({ chatId: externalId }) }
  }

  resolveRoute(event: IntegrationInputEvent): IntegrationRoute {
    const message = event.payload as IncomingMessage
    let displayName = deriveDisplayName(message)
    if (message.chatId.includes('|')) {
      const date = message.timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      const time = message.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      displayName = displayName ? `${displayName} — ${date}, ${time}` : `${date}, ${time}`
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
    const message = event.payload as IncomingMessage
    const integrationId = context.integration.id
    const chatId = context.externalId
    const decision = decideInboundAccess({ integrationId, externalChatId: chatId, chatType: message.chatType,
      userId: message.userId, userName: message.userName, chatName: message.chatName, preview: message.text })
    if (decision.action !== 'blocked') return true
    if (decision.sendNotice) {
      const access = getChatAccess(integrationId, chatId)
      if (access) {
        try {
          await this.sendMessage(chatId, { text: 'This bot needs the owner to approve this conversation before it can respond.' })
          markNoticeSent(access.id)
        } catch (error) {
          captureException(error, { tags: { component: 'chat-integration', operation: 'access-notice' }, level: 'warning' })
        }
      }
    }
    return false
  }

  isAllowed(context: IntegrationSessionContext): boolean {
    return isChatAllowed(context.integration.id, context.externalId)
  }

  sessionPolicy(integration: AgentIntegrationRecord, route: Partial<IntegrationRoute>): IntegrationSessionPolicy {
    const { sessionTimeout } = chatSettings(integration)
    return {
      timeoutHours: sessionTimeout,
      name: buildSessionName(integration.name, integration.provider, route.displayName, sessionTimeout),
      metadata: { isChatIntegrationSession: true, chatIntegrationId: integration.id },
    }
  }

  shouldUpdateDisplayName(current: string | null | undefined): boolean {
    return isDisplayNameFallback(current)
  }

  async prepareInput(event: IntegrationInputEvent, context: IntegrationInputContext): Promise<PreparedIntegrationInput> {
    const message = event.payload as IncomingMessage
    const { text, failedFiles } = await this.inputBuilder.buildMessageContent(context.integration, message)
    const skip = failedFiles.length > 0 && !text.trim()
    if (failedFiles.length && this.isAllowed(context)) {
      await this.sendMessage(context.externalId, { text: `Could not download file(s): ${failedFiles.join(', ')}. ${skip ? 'Message was not sent to the agent.' : 'Your text message will still be sent.'}\n\nIf this is a Slack bot, ensure the \`files:read\` scope is added and the app is reinstalled.` })
    }
    return { text, skip, systemPrompt: (this.constructor as ChatConnectorClass).generateSystemPrompt?.(message) }
  }

  async consumeInput(event: IntegrationInputEvent, context: IntegrationInputContext, input: PreparedIntegrationInput): Promise<boolean> {
    if (!context.sessionId) return false
    const message = event.payload as IncomingMessage
    const { actor } = context
    return consumeOrCancelAwaitingInput({
      sessionId: context.sessionId, agentSlug: context.integration.agentSlug, chatId: context.externalId,
      messageText: input.text, answerText: message.text, hasFiles: !!message.files?.length,
      persister: { isSessionAwaitingInput: (_slug, id) => actor.sessions.isAwaitingInput(id), cancelAwaitingInput: (_slug, id) => actor.inputs.cancelAwaiting(id) },
      registry: { getOpenRequestsForSession: (_slug, id) => actor.inputs.open(id) }, connector: this,
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
        sseUnsubscribe: null, messageUnsubscribe: null, interactiveUnsubscribe: null, errorUnsubscribe: null,
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
    if (output.type === 'request') {
      const card = reviewCardFromRegistry(output.request)
      if (card) await this.sendUserRequestCard(context.externalId, card, context.sessionId)
      return
    }
    const state = this.deliveryState(context)
    if (output.type === 'turn-started') { state.turnNotified = false; return }
    if (output.type !== 'runtime' && output.type !== 'turn-completed' && output.type !== 'turn-failed') return
    await processSSEEvent(state, output.event, chatSettings(context.integration).showToolCalls, context.sessionId ?? '')
  }

  observeSession(context: IntegrationSessionContext): void {
    if (!context.sessionId) return
    const state = this.deliveryState(context)
    const activity = agentRegistry.get(context.integration.agentSlug).sessions.activity(context.sessionId)
    armIndicatorIfBusy(state, context.sessionId, activity)
    if (!BUSY_ACTIVITIES.has(activity)) clearIndicator(state)
  }

  releaseSession(context: IntegrationSessionContext): void {
    const state = this.deliverySessions.get(context.externalId)
    if (!state || (context.sessionId && state.sessionId !== context.sessionId)) return
    stopIndicatorTick(state)
    void this.stopWorking(context.externalId).catch(() => {})
    this.deliverySessions.delete(context.externalId)
  }

  getTools(context: IntegrationSessionContext): readonly IntegrationTool[] {
    const stringArgument = (input: unknown, key: string) => z.object({ [key]: z.string().min(1) }).parse(input)[key]
    const tool = (name: string, description: string, properties: Record<string, unknown>, execute: IntegrationTool['execute']): IntegrationTool => ({
      name, description, inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }, execute,
    })
    const tools = [tool('send_message', 'Send a complete message to an external conversation.', { text: { type: 'string' } }, async input => {
      if (!this.isAllowed(context)) throw new Error('Conversation is not allowed')
      const text = stringArgument(input, 'text')
      await this.startWorking(context.externalId, 'working').catch(() => {})
      try {
        await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 1100))
        if (!this.isAllowed(context)) throw new Error('Conversation is not allowed')
        return await this.sendMessage(context.externalId, { text })
      } finally { await this.stopWorking(context.externalId).catch(() => {}) }
    })]
    if (this.listChatUsers) tools.push(tool('list_users', 'List reachable people.', {}, () => this.listChatUsers!()))
    if (this.listChatChannels) tools.push(tool('list_channels', 'List reachable channels.', {}, () => this.listChatChannels!()))
    if (this.resolveDirectChat) tools.push(tool('dm_by_user_id', 'Resolve a direct conversation.', { userId: { type: 'string' } }, input => this.resolveDirectChat!(stringArgument(input, 'userId'))))
    return tools
  }

  // ── Event subscription ──────────────────────────────────────────────

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler)
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler)
    }
  }

  onInteractiveResponse(handler: InteractiveResponseHandler): () => void {
    this.interactiveResponseHandlers.push(handler)
    return () => {
      this.interactiveResponseHandlers = this.interactiveResponseHandlers.filter((h) => h !== handler)
    }
  }

  /** Subscribe to typing hints (e.g. external user started typing). Useful for pre-warming containers. */
  onTypingHint(handler: TypingHintHandler): () => void {
    this.typingHintHandlers.push(handler)
    return () => {
      this.typingHintHandlers = this.typingHintHandlers.filter((h) => h !== handler)
    }
  }

  // ── Protected helpers for subclasses ────────────────────────────────

  protected emitMessage(message: IncomingMessage): void {
    void this.emitEvent({ type: 'input', id: message.externalMessageId, externalId: message.chatId, timestamp: message.timestamp, payload: message }).catch(error => this.emitError(error instanceof Error ? error : new Error(String(error))))
    for (const handler of this.messageHandlers) {
      try {
        handler(message)
      } catch (err) {
        console.error('[ChatConnector] Error in message handler:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'emit-message' }, extra: { provider: this.provider, chatId: message.chatId } })
      }
    }
  }

  protected emitInteractiveResponse(toolUseId: string, response: unknown, chatId?: string): void {
    const review = toolUseId.startsWith('review:')
    const value = response as { answer?: string; question?: string; answers?: Record<string, string> } | undefined
    void this.emitEvent({
      type: 'response', externalId: chatId ?? '',
      requestId: review ? toolUseId.split(':')[1] : toolUseId,
      requestKind: review ? 'review' : 'input',
      value: review ? (value?.answer?.toLowerCase().includes('allow') ? 'allow' : 'deny')
        : value?.question && value.answer !== undefined ? value.answers ?? { [value.question]: value.answer } : response,
    }).catch(error => this.emitError(error instanceof Error ? error : new Error(String(error))))
    for (const handler of this.interactiveResponseHandlers) {
      try {
        handler(toolUseId, response, chatId)
      } catch (err) {
        console.error('[ChatConnector] Error in interactive response handler:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'emit-interactive-response' }, extra: { provider: this.provider, toolUseId } })
      }
    }
  }

  protected emitTypingHint(chatId: string): void {
    void this.emitEvent({ type: 'hint', externalId: chatId }).catch(() => {})
    for (const handler of this.typingHintHandlers) {
      try {
        handler(chatId)
      } catch {
        // Non-critical — best-effort pre-warm
      }
    }
  }
}
