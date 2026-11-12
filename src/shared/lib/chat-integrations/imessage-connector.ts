/**
 * IMessageConnector — iMessage integration via the iMessage Gateway service.
 *
 * Connects to the gateway over WebSocket. No streaming (iMessage has a 5-edit
 * limit) — shows typing indicator while the agent works, then sends the
 * complete message. Approvals use tapback reactions; questions use plain text.
 *
 * Each connection uses one of two modes. With the host's webhook relay it
 * opens no socket: the relay endpoint is the phone's gateway webhook, so every
 * event arrives through the relay (including those from while the host was
 * offline), and commands go over the gateway's HTTP API. Without a relay, one
 * socket carries both, acking each event once it's handled. See
 * imessage-webhooks.ts and imessage-gateway-client.ts.
 */

import type { AgentIntegrationRecord, IntegrationInputEvent, IntegrationInputResult } from '../agent-integrations/types'
import type { IntegrationRelayAttachment, IntegrationRelayHost } from '../agent-integrations/transport'
import { relayAcceptResult } from '../agent-integrations/relay-transport'
import { IntegrationSetupError } from '../agent-integrations/setup-types'
import type { RelayAcceptResult, RelayEvent } from '../webhook-relay'
import type { IMessageConfig } from './config-schema'
import { IMESSAGE_WEBHOOK_EVENTS, checkIMessageWebhook, ensureIMessageWebhook } from './imessage-webhooks'
import { incomingMessageSchema } from './message-schema'
import {
  markGatewayChatRead, registerGatewayWebhook, requestGatewayUpload, sendGatewayMessage, sendGatewayReaction, startGatewayTyping,
  GatewayRequestError, type GatewayMessagePart, type GatewayTextDecoration, type GatewayUpload,
} from './imessage-gateway-client'
import { getAgentRecord } from '../services/agent-service'
import { buildAgentContactCard, resolveAgentWebUrl } from './contact-card'
import { displaySlug } from '../utils/file-storage'
import { sanitizeUploadFilename } from '../utils/path-safety'

import WebSocket from 'ws'
import { Marked, type Token, type Tokens } from 'marked'
import type { UserRequestEvent } from '@shared/lib/tools/types'
import type { SessionActivity } from '@shared/lib/types/agent'
import {
  ChatAgentIntegration,
  isMultiPartyChatType,
  type ChatClassifyContext,
  type ChatConversationType,
  type OutgoingMessage,
  type SystemPromptContext,
} from './chat-agent-integration'
import { buildSessionContextPrompt } from './chat-session-context'
import { describeUnsupportedRequest, isUnsupportedInChat } from './utils'
import { withSessionUrl, type AppLinkContext } from '@shared/lib/agent-integrations/app-link'
import { captureException } from '@shared/lib/error-reporting'
import { background } from '@shared/lib/background'

// ── Gateway events ──────────────────────────────────────────────────────

/** A frame from the gateway. Events carry an `id` (stable across redeliveries) to ack and dedupe on. */
interface GatewayFrame {
  type: string
  id?: string
  data?: any
}

/**
 * Events the gateway keeps until they're acked; the rest are best-effort.
 * Unacked within ~5s, one goes to the webhook, else waits for the next socket.
 */
const ACKED_EVENT_TYPES = new Set(['message.received', 'message.sent', 'message.failed', 'message.edited', 'reaction.added', 'reaction.removed'])

/** Where an event came from: the socket, or the relay (live, or long after the fact). */
type EventSource = 'socket' | 'relay'

/** What became of an event: the host's answer for a message, or nothing to hand over. */
type ReceiveOutcome = IntegrationInputResult | 'ignored'

/** Events handled recently, so one delivered on both paths acts once. */
const MAX_HANDLED_EVENTS = 1000

// ── Reaction tag parsing ────────────────────────────────────────────────

const REACTION_TAG_RE = /\[\[reaction:([^\]\s]+)\]\]/g
const EMOJI_START_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)/u
const GRAPHEMES = new Intl.Segmenter()

/** Whether a reaction tag holds exactly one emoji, which goes out as a custom tapback. */
function isSingleEmoji(text: string): boolean {
  return EMOJI_START_RE.test(text) && [...GRAPHEMES.segment(text)].length === 1
}

const REACTION_NAME_TO_TYPE: Record<string, string> = {
  heart: 'love',
  love: 'love',
  thumbs_up: 'like',
  like: 'like',
  thumbs_down: 'dislike',
  dislike: 'dislike',
  haha: 'laugh',
  laugh: 'laugh',
  exclamation: 'emphasize',
  emphasize: 'emphasize',
  question: 'question',
  '!!': 'emphasize',
  '?': 'question',
}

// ── Markdown → iMessage text ────────────────────────────────────────────

const imessageMarked = new Marked({ async: false, gfm: true })
const isList = (token: Token): token is Tokens.List => token.type === 'list'
const isTable = (token: Token): token is Tokens.Table => token.type === 'table'
/** Past about one phone line, an item wraps to the bubble's left edge, so its list needs a blank line between items to read. */
const LONG_LIST_ITEM = 50

/**
 * Markdown as iMessage shows it: plain text, with bold, italic and
 * strikethrough as decorations over ranges of that text. Linq sends text
 * as-is, so markdown syntax would otherwise arrive as literal characters.
 * With `previews`, https links leave the text for `links`, each to be sent
 * as its own message so iMessage draws a preview card.
 */
export function markdownToIMessage(md: string, { previews = false } = {}): { text: string; decorations: GatewayTextDecoration[]; links: string[] } {
  let text = ''
  const decorations: GatewayTextDecoration[] = []
  const links: string[] = []

  const styled = (type: GatewayTextDecoration['type'], tokens: Token[]) => {
    const start = text.length
    inline(tokens)
    if (text.slice(start).trim()) decorations.push({ type, range: { start, length: text.length - start } })
  }

  const inline = (tokens: Token[]) => {
    for (const token of tokens) {
      switch (token.type) {
        case 'strong': styled('bold', token.tokens ?? []); break
        case 'em': styled('italic', token.tokens ?? []); break
        case 'del': styled('strikethrough', token.tokens ?? []); break
        case 'link': {
          const bare = token.autolink || token.href === token.text
          if (previews && /^https:\/\//i.test(token.href)) {
            if (!links.includes(token.href)) links.push(token.href)
            if (!bare) inline(token.tokens ?? [])
            break
          }
          inline(token.tokens ?? [])
          if (!bare) text += ` (${token.href})`
          break
        }
        case 'image': text += token.text ? `${token.text} (${token.href})` : token.href; break
        case 'checkbox': text += token.checked ? '☑ ' : '☐ '; break
        case 'br': text += '\n'; break
        case 'text': if (token.tokens) inline(token.tokens); else text += token.text; break
        case 'codespan':
        case 'escape':
        case 'html': text += token.text; break
        default: text += token.raw
      }
    }
  }

  const blocks = (tokens: Token[], indent: string) => {
    let first = true
    const startBlock = () => { if (!first) text += '\n\n'; first = false }
    for (const token of tokens) {
      const before = text.length
      const wasFirst: boolean = first
      switch (token.type) {
        case 'space':
        case 'hr':
        case 'def': break
        case 'paragraph':
        case 'text': startBlock(); inline(token.tokens ?? [token]); break
        case 'heading': startBlock(); styled('bold', token.tokens ?? []); break
        case 'code': startBlock(); text += token.text; break
        case 'blockquote': startBlock(); blocks(token.tokens ?? [], indent); break
        default:
          startBlock()
          if (isList(token)) list(token, indent)
          else if (isTable(token)) {
            for (const [i, row] of [token.header, ...token.rows].entries()) {
              if (i > 0) text += '\n'
              row.forEach((cell, j) => { if (j > 0) text += ' · '; inline(cell.tokens) })
            }
          } else text += token.raw.trim()
      }
      // A block that was only a moved-out link leaves no empty paragraph behind.
      if (previews && !text.slice(before).trim()) { text = text.slice(0, before); first = wasFirst }
    }
  }

  const list = (token: Tokens.List, indent: string) => {
    // An item's own line as shown: nested lists below it and link addresses inside it don't count.
    const shownLength = (item: Tokens.ListItem) => item.text.split('\n')[0].replace(/\]\([^)]*\)/g, ']').length
    const gap = token.items.some(item => shownLength(item) > LONG_LIST_ITEM) ? '\n\n' : '\n'
    let shown = 0
    for (const item of token.items) {
      const before = text.length
      if (shown > 0) text += gap
      text += indent + (token.ordered ? `${Number(token.start) + shown}. ` : '• ')
      const content = text.length
      item.tokens.forEach((child, j) => {
        if (isList(child)) { text += '\n'; list(child, indent + '  ') }
        else if (child.type === 'checkbox') inline([child])
        else { if (j > 0 && item.tokens[j - 1].type !== 'checkbox') text += '\n'; blocks([child], indent) }
      })
      // A nested list or paragraph left empty by moved-out links leaves no blank line in the item.
      if (previews) text = text.slice(0, content) + text.slice(content).replace(/\n+$/, '')
      if (!previews || text.slice(content).trim()) shown++
      else text = text.slice(0, before)
    }
  }

  blocks(imessageMarked.lexer(md), '')
  return { text, decorations, links }
}

// Map incoming gateway reaction types to approval decisions
const APPROVAL_ALLOW_REACTIONS = new Set(['like', 'love'])
const APPROVAL_DENY_REACTIONS = new Set(['dislike'])

// ── Pending interactive state ───────────────────────────────────────────

interface PendingApproval {
  toolUseId: string
  sentMessageId: string
}

interface PendingQuestion {
  toolUseId: string
  questions: Array<{
    question: string
    options: Array<{ label: string; value?: string }>
  }>
}

/**
 * Classify an iMessage chat. This depends on the bridge contract that chatName
 * is present only for group chats.
 * Without a name we return undefined (not dm) so listing callers that only
 * have a chat id do not mislabel groups as private.
 */
export function classifyIMessageChat(chat: ChatClassifyContext): ChatConversationType | undefined {
  return chat.chatName ? 'group' : undefined
}

const IMESSAGE_PROVIDER_RULES = `- Prefer asking questions directly in natural language rather than using the ask questions tool.

- Before your first tool call, write [[reaction:<emoji>]] for what you're about to do, using the object for the action: 👀 starting, 🔍 searching, 📖 reading, ✍️ writing, ✉️ email, 📅 calendar, ⏰ reminder, 🛒 buying, ✋ need your OK, 👍 done, 🚧 couldn't. React again when the kind of work changes. Each reaction replaces your last one on the user's latest message. A reaction alone can be the whole answer. When you finish an action and nothing else needs saying, end on its object instead of a text.
- The user may send voice notes which are automatically transcribed.
- Each https link in your reply arrives as its own message after your text, where iMessage shows it as a preview card. Give a link a label, like [the menu](https://example.com), so your sentence keeps its words. A bare address is taken out of the sentence.`

export function buildIMessageSystemPrompt(message: SystemPromptContext): string {
  const kind = classifyIMessageChat(message)
  const shared = buildSessionContextPrompt({
    surface: 'chat',
    where: kind === 'group'
      ? 'a live iMessage group conversation'
      : 'a live iMessage conversation',
    multiParty: isMultiPartyChatType(kind),
  })
  return `${shared}\n${IMESSAGE_PROVIDER_RULES}`
}

// ── Connector ───────────────────────────────────────────────────────────

export class IMessageConnector extends ChatAgentIntegration {
  /** Introduce this identity once at setup, never on boot or reconnect. */
  async onCreated(integration: AgentIntegrationRecord): Promise<void> {
    const agent = await getAgentRecord(integration.agentSlug)
    if (!agent) return
    const name = integration.name?.trim() || agent.name
    const card = buildAgentContactCard({ slug: integration.agentSlug, name, description: agent.description,
      appUrl: await resolveAgentWebUrl(displaySlug(agent.name, integration.agentSlug)) })
    const filename = `${sanitizeUploadFilename(name)}.vcf`
    const caption = "Save me as a contact so I'm not just a number. Text me anytime."
    try {
      await this.sendFile('', card, filename, caption)
    } catch (err) {
      captureException(err, { tags: { component: 'chat-integration', operation: 'imessage-send-file' } })
      await this.sendMessage('', { text: `[File: ${filename}] — ${caption}` })
    }
  }

  readonly provider = 'imessage' as const

  static generateSystemPrompt = buildIMessageSystemPrompt
  static classifyChatId = classifyIMessageChat

  private ws: WebSocket | null = null
  private _connected = false
  private disconnecting = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private static readonly MAX_RECONNECT_DELAY_MS = 60_000
  private static readonly BASE_RECONNECT_DELAY_MS = 1_000

  private pingInterval: ReturnType<typeof setInterval> | null = null
  private pongReceived = true
  private static readonly PING_INTERVAL_MS = 30_000
  private static readonly PONG_TIMEOUT_MS = 10_000

  /** Each chat's newest message, which reactions in that chat go to. */
  private readonly latestMessages = new Map<string, { id: string; at: number }>()
  private lastChatId: string | null = null
  // Chats currently showing the typing bubble. The manager's tick calls startWorking
  // every ~1s for keep-alive; iMessage's bubble self-expires, so we send start_typing
  // once per working segment (on the not-shown→shown edge) instead of on every tick.
  private typingShown: Set<string> = new Set()
  private pendingApprovals: Map<string, PendingApproval> = new Map()
  private pendingQuestions: Map<string, PendingQuestion> = new Map()

  // Track message.sent confirmations for upload flow
  private sentMessageResolvers: Map<string, (messageId: string) => void> = new Map()
  private uploadResolvers: Map<string, (data: GatewayUpload) => void> = new Map()
  private nextUploadId = 0
  private nextApprovalId = 0

  /** Bumped by each connect and disconnect; relayed events from an older connection are retried. */
  private generation = 0
  /** How this connection talks to the gateway, chosen as it connects. */
  private mode: 'socket' | 'webhooks' | null = null
  private relayAttachment?: IntegrationRelayAttachment
  /** Read receipts waiting to go out over HTTP, one per chat however many messages arrive. */
  private readonly readReceipts = new Map<string, ReturnType<typeof setTimeout>>()
  /** Per group chat, the newest accepted message waiting for its 👀, until the agent reacts first. */
  private readonly groupAcks = new Map<string, { messageId: string; at: number; timer: ReturnType<typeof setTimeout> }>()
  private static readonly READ_RECEIPT_DELAY_MS = 1_000
  /** One event at a time, in arrival order, whichever path it came on. */
  private processing: Promise<unknown> = Promise.resolve()
  private readonly handledEvents = new Set<string>()
  /** Send time of the newest message received; relayed backlog can arrive after newer ones. */
  private lastReceivedAt = 0

  /**
   * `integration` is the installation this connects for. Without it the relay
   * is never used (its endpoint is saved on the installation).
   */
  constructor(
    private config: IMessageConfig,
    private appLink?: AppLinkContext,
    private integration?: Pick<AgentIntegrationRecord, 'id' | 'agentSlug' | 'createdByUserId'>,
  ) {
    super()
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.disconnecting = false
    this.reconnectAttempts = 0
    const generation = ++this.generation

    // Webhooks whenever the host has a relay as this connection starts; the
    // socket otherwise, or if webhooks can't be set up right now.
    const relay = this.integration ? this.host.relay : null
    if (relay && this.integration && await this.connectWebhooks(relay, this.integration, generation)) return
    if (generation !== this.generation) return
    this.mode = 'socket'
    await this.doConnect()
  }

  /** Receives through the relay and sends over HTTP, with no socket. False leaves this connection to the socket. */
  private async connectWebhooks(relay: IntegrationRelayHost, integration: NonNullable<IMessageConnector['integration']>, generation: number): Promise<boolean> {
    let webhook: Awaited<ReturnType<typeof ensureIMessageWebhook>>
    try {
      webhook = await ensureIMessageWebhook(integration)
      if (!webhook || generation !== this.generation) return false
      // Every connect: the gateway drops a webhook whose endpoint answered
      // 404/410, and an identical registration retries what it held or parked.
      await registerGatewayWebhook(this.config, { url: webhook.relay.url, secret: webhook.secret, events: IMESSAGE_WEBHOOK_EVENTS })
    } catch (error) {
      if (error instanceof IntegrationSetupError) console.warn(`[IMessageConnector] Using the socket for ${integration.id}: ${error.message}`)
      else this.report(error, 'imessage-webhooks')
      return false
    }
    if (generation !== this.generation) return false
    const { secret } = webhook
    this.mode = 'webhooks'
    this.relayAttachment = relay.attach(webhook.relay, events => this.acceptRelayed(events, secret, generation))
    console.log(`[IMessageConnector] Receiving through webhooks for ${integration.id}`)
    return true
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const phone = encodeURIComponent(this.config.phoneNumber)
      const url = `${this.config.gatewayUrl.replace(/^http/, 'ws')}/ws/${phone}`

      this.ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.config.token}` },
      })

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          reject(new Error('iMessage gateway connection timeout'))
          this.ws?.close()
        }
      }, 15_000)

      this.ws.on('open', () => {
        this.send({ type: 'ready', acks: true })
      })

      this.ws.on('pong', () => {
        this.pongReceived = true
      })

      this.ws.on('message', (raw) => {
        let frame: GatewayFrame
        try {
          frame = JSON.parse(raw.toString())
        } catch (err) {
          console.error('[IMessageConnector] Failed to parse server message:', err)
          return
        }
        if (!resolved && frame.type === 'connected') {
          resolved = true
          clearTimeout(timeout)
          this._connected = true
          this.reconnectAttempts = 0
          this.startPingLoop()
          console.log(`[IMessageConnector] Connected (${frame.data?.queuedCount ?? 0} queued events)`)
          resolve()
        }
        background(this.receiveSocketFrame(frame), { name: 'imessage-connector.receive-socket-frame' })
      })

      this.ws.on('error', (err) => {
        console.error('[IMessageConnector] WebSocket error:', err)
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          reject(err)
        }
      })

      this.ws.on('close', (code, reason) => {
        this._connected = false
        const reasonStr = reason?.toString() || ''
        console.log(`[IMessageConnector] Disconnected (code=${code}, reason=${reasonStr})`)

        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          reject(new Error(`WebSocket closed during connect: code=${code}`))
          return
        }

        // Code 4000 = replaced by another connection — don't reconnect
        if (code === 4000 || this.disconnecting) return

        this.scheduleReconnect()
      })
    })
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true
    this._connected = false
    this.generation++
    this.mode = null
    this.relayAttachment?.detach()
    this.relayAttachment = undefined
    for (const timer of this.readReceipts.values()) clearTimeout(timer)
    this.readReceipts.clear()
    for (const ack of this.groupAcks.values()) clearTimeout(ack.timer)
    this.groupAcks.clear()

    this.stopPingLoop()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.pendingApprovals.clear()
    this.pendingQuestions.clear()
    this.sentMessageResolvers.clear()
    this.uploadResolvers.clear()

    if (this.ws) {
      this.ws.close(1000)
      this.ws = null
    }
    // Events mid-hand-over finish (or come back as retries) before the next connection starts.
    await this.processing.catch(() => {})
    console.log('[IMessageConnector] Disconnected')
  }

  isConnected(): boolean {
    // Through webhooks, events wait on the relay while it's down, so being attached is enough.
    return this.mode === 'webhooks' ? !!this.relayAttachment?.isAttached() : this._connected
  }

  activeTransport() {
    if (this.mode === 'webhooks') return this.relayAttachment?.isAttached() ? 'relay' as const : null
    return this._connected ? 'direct' as const : null
  }

  // ── Message sending ─────────────────────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<string> {
    const text = message.text || ''
    const targetChatId = chatId || this.lastChatId || undefined

    // Parse and handle reaction tags
    const { cleanText, reactions } = this.extractReactions(text)

    // Send reactions to the user's last message in this chat
    const latest = targetChatId && this.latestMessages.get(targetChatId)
    if (latest && reactions.length > 0) {
      this.cancelGroupAck(targetChatId)
      for (const reaction of reactions) this.react(latest.id, reaction)
    }

    // Previews need an existing chat (a chat's first message can't be a link) and sends that
    // complete in order, which only the HTTP path awaits.
    const previews = !!targetChatId && this.mode === 'webhooks'
    const { text: converted, decorations, links } = markdownToIMessage(cleanText, { previews })
    // Text that converts to nothing (a lone rule or link definition) still goes out as written.
    const body = converted.trim() ? converted : links.length > 0 ? '' : cleanText.trim()

    // If only reactions, no text to send
    if (!body && links.length === 0) {
      return `reaction-only-${Date.now()}`
    }

    // The reply's id is its text message's, or its first preview's when it has no text.
    let replyId = body ? await this.postMessage(targetChatId, [{ type: 'text', value: body }], decorations) : null
    // Once part of the reply is out, a failure must not fail the reply: delivery would resend it all.
    let delivered = !!body
    for (const [i, url] of links.entries()) {
      try {
        const linkId = await this.postMessage(targetChatId, [{ type: 'link', value: url }])
        replyId ??= linkId
        delivered = true
      } catch (err) {
        // Only a preview the gateway answered as refused is known unsent. Its address and the
        // rest still go out, as text. Otherwise it may have arrived, so nothing is resent.
        const statusOf = (e: unknown) => e instanceof GatewayRequestError ? e.status : 'error'
        console.warn('[IMessageConnector] Link preview not sent:', statusOf(err))
        if (!(err instanceof GatewayRequestError && err.status !== null && !err.retryable)) {
          if (!delivered) throw err
          break
        }
        try {
          const fallbackId = await this.postMessage(targetChatId, [{ type: 'text', value: links.slice(i).join('\n') }])
          replyId ??= fallbackId
        } catch (fallbackErr) {
          if (!delivered) throw fallbackErr
          console.warn('[IMessageConnector] Link addresses not sent:', statusOf(fallbackErr))
        }
        break
      }
    }
    return replyId ?? `msg-${Date.now()}`
  }

  async sendStreamingUpdate(_chatId: string, _text: string, existingMessageId?: string): Promise<string> {
    // No streaming for iMessage — return a placeholder
    return existingMessageId || `stream-noop-${Date.now()}`
  }

  async finalizeStreamingMessage(chatId: string, _messageId: string, finalText: string): Promise<void> {
    // Since we don't stream, send the complete message now
    await this.sendMessage(chatId, { text: finalText })
  }

  async startWorking(chatId: string, _activity: SessionActivity): Promise<void> {
    // iMessage shows only a typing indicator, so the activity label is unused.
    const targetChatId = chatId || this.lastChatId
    if (!targetChatId) return
    if (this.typingShown.has(targetChatId)) return // already shown — tick keep-alive no-ops
    this.typingShown.add(targetChatId)
    this.startTyping(targetChatId)
  }

  async stopWorking(chatId: string): Promise<void> {
    // No stop_typing command exists; the OS bubble self-expires. Clear the shown flag
    // so the next working segment re-arms start_typing.
    const targetChatId = chatId || this.lastChatId
    if (targetChatId) this.typingShown.delete(targetChatId)
  }

  async sendFile(chatId: string, fileData: Buffer, filename: string, caption?: string): Promise<string> {
    const targetChatId = chatId || this.lastChatId || undefined
    const mimeType = guessMimeType(filename)
    const { text: captionText, decorations } = markdownToIMessage(caption ?? '')

    // 1. Request upload URL
    const uploadInfo = await this.requestUpload({ filename, contentType: mimeType, sizeBytes: fileData.length })

    // 2. Upload the file
    const uploadHeaders = new Headers(uploadInfo.requiredHeaders)
    // Fetch computes the byte body's length; forwarding it duplicates the header with Undici's dispatcher.
    uploadHeaders.delete('content-length')
    const uploadRes = await fetch(uploadInfo.uploadUrl, {
      method: 'PUT',
      headers: uploadHeaders,
      body: new Uint8Array(fileData),
    })
    if (!uploadRes.ok) {
      throw new Error(`File upload failed: ${uploadRes.status}`)
    }

    // 3. Send message with attachment
    const parts: GatewayMessagePart[] = [
      { type: 'media', attachmentId: uploadInfo.attachmentId },
    ]
    if (captionText) {
      parts.push({ type: 'text', value: captionText })
    }

    await this.postMessage(targetChatId, parts, decorations)
    return `file-${Date.now()}`
  }

  // ── User request cards ──────────────────────────────────────────────

  async sendUserRequestCard(chatId: string, event: UserRequestEvent, sessionId?: string): Promise<string> {
    const appLink = withSessionUrl(this.appLink, sessionId)
    const targetChatId = chatId || this.lastChatId || undefined
    if (isUnsupportedInChat(event)) {
      return this.sendTextAndReturn(describeUnsupportedRequest(event, appLink), targetChatId)
    }

    switch (event.type) {
      case 'question_request': {
        // Handle proxy review requests (approval cards)
        if (event.toolUseId.startsWith('review:')) {
          return this.sendApprovalCard(event, targetChatId)
        }
        return this.sendQuestionCard(event, targetChatId)
      }

      // secret_request / file_request are handled by the isUnsupportedInChat early-return above
      // (desktop-only fallback); they intentionally have no prompt case here.

      case 'file_delivery': {
        const text = `File delivered: ${event.filePath}${event.description ? `\n${event.description}` : ''}`
        return this.sendTextAndReturn(text, targetChatId)
      }

      case 'tool_status': {
        const emoji = event.status === 'success' ? '✅' : event.status === 'error' ? '❌' : event.status === 'cancelled' ? '⛔' : '⏳'
        const text = `${event.toolName} — ${event.summary} ${emoji}`
        return this.sendTextAndReturn(text, targetChatId)
      }

      default: {
        return this.sendTextAndReturn(describeUnsupportedRequest(event, appLink), targetChatId)
      }
    }
  }

  private async sendApprovalCard(event: UserRequestEvent, targetChatId?: string): Promise<string> {
    const questions = (event as any).questions as Array<{ question: string }> | undefined
    const displayText = questions?.[0]?.question || 'Allow this action?'
    const text = `${displayText}\n\nReact with 👍 to allow, 👎 to deny.`

    // Over HTTP the gateway answers with the message's id, which reactions to
    // it carry. Over the socket it isn't known yet; message.sent fills it in.
    const sentId = await this.postMessage(targetChatId, [{ type: 'text', value: text }])
    const messageId = sentId ?? `approval-${this.nextApprovalId++}`

    this.pendingApprovals.set(messageId, {
      toolUseId: event.toolUseId,
      sentMessageId: messageId,
    })

    return messageId
  }

  private async sendQuestionCard(event: UserRequestEvent, targetChatId?: string): Promise<string> {
    const questions = (event as any).questions as Array<{
      question: string
      header?: string
      options?: Array<{ label: string; value?: string; description?: string }>
    }>

    if (!questions || questions.length === 0) {
      return this.sendTextAndReturn('(No question provided)', targetChatId)
    }

    const lines: string[] = []
    for (const q of questions) {
      if (q.header) lines.push(`*${q.header}*`)
      lines.push(q.question)
      if (q.options && q.options.length > 0) {
        for (let i = 0; i < q.options.length; i++) {
          const opt = q.options[i]
          const desc = opt.description ? ` — ${opt.description}` : ''
          lines.push(`  ${i + 1}. ${opt.label}${desc}`)
        }
        lines.push('\nReply with a number or type your answer.')
      }
      lines.push('')
    }

    const text = lines.join('\n').trim()
    // Pending before it's sent, so a quick answer can't arrive ahead of it.
    this.pendingQuestions.set(event.toolUseId, {
      toolUseId: event.toolUseId,
      questions: questions.map(q => ({
        question: q.question,
        options: q.options || [],
      })),
    })
    try {
      await this.postMessage(targetChatId, [{ type: 'text', value: text }])
    } catch (error) {
      this.pendingQuestions.delete(event.toolUseId)
      throw error
    }

    return `question-${Date.now()}`
  }

  // ── Server event handling ────────────────────────────────────────────

  /**
   * Acks an event once it's the host's to keep: a message stored for
   * delivery (not handed to the agent, which can wait on a container), or
   * anything else handled. Unacked (a retry or a failure), the gateway hands
   * it to the webhook or holds it for the next socket.
   */
  private async receiveSocketFrame(frame: GatewayFrame): Promise<void> {
    if (this.handleControlFrame(frame)) return
    const outcome = await this.receive(frame, 'socket')
    if (frame.id && ACKED_EVENT_TYPES.has(frame.type) && outcome !== 'retry') this.send({ type: 'ack', ids: [frame.id] })
  }

  /** Replies to this connection's own commands, never queued behind inbound events. */
  private handleControlFrame(frame: GatewayFrame): boolean {
    switch (frame.type) {
      case 'connected':
        // Already handled in doConnect
        return true

      case 'upload_attachment.response':
        this.handleUploadResponse(frame.data)
        return true

      case 'error': {
        const msg = frame.data?.message || 'unknown'
        console.error('[IMessageConnector] Gateway error:', frame.data)
        if (!/typing indicators are not supported/i.test(msg)) this.emitError(new Error(`Gateway error: ${msg}`))
        return true
      }

      default:
        return false
    }
  }

  private receive(frame: GatewayFrame, source: EventSource): Promise<ReceiveOutcome> {
    const outcome = this.processing.then(() => this.process(frame, source)).catch((error): ReceiveOutcome => {
      this.report(error, 'imessage-event')
      return 'retry'
    })
    this.processing = outcome
    return outcome
  }

  private async process(frame: GatewayFrame, source: EventSource): Promise<ReceiveOutcome> {
    const key = frame.id ?? (frame.type === 'message.received' && frame.data?.messageId ? `message:${frame.data.messageId}` : undefined)
    if (key && this.handledEvents.has(key)) return 'duplicate'
    const outcome = await this.handleEvent(frame, source)
    if (key && outcome !== 'retry') {
      this.handledEvents.add(key)
      if (this.handledEvents.size > MAX_HANDLED_EVENTS) this.handledEvents.delete(this.handledEvents.values().next().value!)
    }
    return outcome
  }

  private async handleEvent(frame: GatewayFrame, source: EventSource): Promise<ReceiveOutcome> {
    switch (frame.type) {
      case 'message.received':
        return this.handleMessageReceived(frame.data)

      case 'reaction.added':
        return this.handleReactionAdded(frame.data, source) ? 'accepted' : 'ignored'

      case 'message.sent':
        // Matched to sends by order, which only the socket keeps. Over HTTP
        // each send already returned its id.
        if (source === 'socket') this.handleMessageSent(frame.data)
        return 'ignored'

      case 'message.failed':
        console.error('[IMessageConnector] Message delivery failed:', frame.data)
        return 'ignored'

      case 'typing.started':
        if (source === 'socket') this.emitTypingHint(this.config.phoneNumber)
        return 'ignored'

      // Ignored events: message.delivered, message.read, typing.stopped, message.edited, reaction.removed
      default:
        return 'ignored'
    }
  }

  private async handleMessageReceived(data: any): Promise<ReceiveOutcome> {
    if (!data) return 'ignored'

    const messageId = data.messageId as string
    const chatId = data.chatId as string || this.config.phoneNumber
    const chatName = data.chatName as string | undefined
    const from = data.from as string
    const parts = data.parts as Array<{ type: string; value?: string; url?: string; mimeType?: string; filename?: string; sizeBytes?: number }> || []
    const sentAt = data.sentAt ? new Date(data.sentAt) : new Date()

    // Reactions go to the newest message, which relayed backlog may not be.
    if (!(sentAt.getTime() < (this.latestMessages.get(chatId)?.at ?? 0))) this.latestMessages.set(chatId, { id: messageId, at: sentAt.getTime() })
    if (!(sentAt.getTime() < this.lastReceivedAt)) {
      this.lastChatId = chatId
      this.lastReceivedAt = sentAt.getTime()
    }

    // Extract text and files from parts
    let text = ''
    const files: Array<{ name: string; url: string; mimeType?: string }> = []

    for (const part of parts) {
      if (part.type === 'text' && part.value) {
        text += (text ? '\n' : '') + part.value
      } else if (part.type === 'media' && part.url) {
        files.push({
          name: part.filename || 'attachment',
          url: part.url,
          mimeType: part.mimeType,
        })
      }
    }

    // Check if there's a pending question — resolve it with this message
    if (this.pendingQuestions.size > 0) {
      this.markRead(chatId)
      this.resolveNextQuestion(text)
      // Don't emit as a regular message — it's an answer to a question
      return 'accepted'
    }

    // Check if there are pending approvals — deny them all and forward message
    if (this.pendingApprovals.size > 0) {
      this.denyAllPendingApprovals()
      // Fall through to emit the message normally
    }

    return this.emitMessage({
      externalMessageId: messageId,
      text,
      chatId,
      chatName,
      userId: from,
      userName: from,
      files: files.length > 0 ? files : undefined,
      timestamp: sentAt,
    })
  }

  /** Returns whether the reaction answered an approval. */
  private handleReactionAdded(data: any, source: EventSource = 'socket'): boolean {
    if (!data) return false
    const reactionType = data.reactionType as string

    // Check if this reaction is on a pending approval message
    for (const [key, approval] of this.pendingApprovals) {
      // Through webhooks, approvals carry their message's real id (the HTTP
      // send returns it), and only a reaction on that message answers one: a
      // relayed reaction can predate a restart, when other approvals were pending.
      if (source === 'relay' && approval.sentMessageId !== data.messageId) continue
      // Over the socket, match any pending approval (we can't perfectly match
      // messageId since we use synthetic IDs, but the gateway will have the real one)
      if (APPROVAL_ALLOW_REACTIONS.has(reactionType)) {
        this.emitInteractiveResponse(approval.toolUseId, {
          question: '_approval',
          answer: '✅ Allow',
        })
        this.pendingApprovals.delete(key)
        return true
      }
      if (APPROVAL_DENY_REACTIONS.has(reactionType)) {
        this.emitInteractiveResponse(approval.toolUseId, {
          question: '_approval',
          answer: '❌ Deny',
        })
        this.pendingApprovals.delete(key)
        return true
      }
    }
    return false
  }

  private handleMessageSent(data: any): void {
    if (!data) return
    const messageId = data.messageId as string
    // Resolve any pending send confirmations
    for (const [key, resolver] of this.sentMessageResolvers) {
      resolver(messageId)
      this.sentMessageResolvers.delete(key)
      break
    }

    // Update pending approval IDs with real message IDs
    for (const [syntheticId, approval] of this.pendingApprovals) {
      if (syntheticId.startsWith('approval-')) {
        this.pendingApprovals.delete(syntheticId)
        this.pendingApprovals.set(messageId, { ...approval, sentMessageId: messageId })
        break
      }
    }
  }

  private handleUploadResponse(data: any): void {
    if (!data) return
    // Resolve the first pending upload
    for (const [key, resolver] of this.uploadResolvers) {
      resolver(data)
      this.uploadResolvers.delete(key)
      break
    }
  }

  // ── Question resolution ──────────────────────────────────────────────

  private resolveNextQuestion(userText: string): void {
    const [toolUseId, pending] = this.pendingQuestions.entries().next().value as [string, PendingQuestion]

    // iMessage is linear — resolve the first question only.
    // Multi-question cards were already rendered as a single numbered list,
    // so the user's reply maps to the first (or only) question.
    const q = pending.questions[0]
    let answer = userText.trim()

    // Try to match by number
    const num = parseInt(answer, 10)
    if (!isNaN(num) && num >= 1 && num <= q.options.length) {
      answer = q.options[num - 1].label
    } else {
      // Try exact label match (case-insensitive)
      const match = q.options.find(o => o.label.toLowerCase() === answer.toLowerCase())
      if (match) {
        answer = match.label
      }
      // Otherwise use the raw text as "Other"
    }

    if (pending.questions.length === 1) {
      this.emitInteractiveResponse(toolUseId, {
        question: q.question,
        answer,
      })
    } else {
      const answers: Record<string, string> = {}
      for (const pq of pending.questions) {
        answers[pq.question] = answer
      }
      this.emitInteractiveResponse(toolUseId, {
        question: '_all',
        answer: '_all',
        answers,
      })
    }

    this.pendingQuestions.delete(toolUseId)
  }

  private denyAllPendingApprovals(): void {
    for (const [key, approval] of this.pendingApprovals) {
      this.emitInteractiveResponse(approval.toolUseId, {
        question: '_approval',
        answer: '❌ Deny',
      })
      this.pendingApprovals.delete(key)
    }
  }

  // ── Reaction parsing ─────────────────────────────────────────────────

  private extractReactions(text: string): { cleanText: string; reactions: string[] } {
    const reactions: string[] = []
    const cleanText = text.replace(REACTION_TAG_RE, (_, name: string) => {
      const mapped = REACTION_NAME_TO_TYPE[name.toLowerCase()] ?? (isSingleEmoji(name) ? name : undefined)
      if (mapped) reactions.push(mapped)
      return ''
    })
    return { cleanText: cleanText.trim(), reactions }
  }

  // ── Relay ────────────────────────────────────────────────────────────

  /** Webhook deliveries the relay claimed, each checked, then handled like a socket event. */
  private async acceptRelayed(events: readonly RelayEvent[], secret: string, generation: number): Promise<Map<string, RelayAcceptResult>> {
    const results = new Map<string, RelayAcceptResult>()
    for (const event of events) results.set(event.id, await this.acceptRelayedEvent(event, secret, generation))
    return results
  }

  private async acceptRelayedEvent(event: RelayEvent, secret: string, generation: number): Promise<RelayAcceptResult> {
    // A replaced or stopped connection's events belong to its successor.
    if (generation !== this.generation) return 'retry'
    // The relay checked the signature on receipt too; this one holds even if
    // the endpoint's profile were cleared. The gateway signs with the secret
    // this host generated, so a mismatch is never a delivery to keep.
    const check = checkIMessageWebhook(event, secret, this.config.phoneNumber)
    if (!check.ok) {
      if (check.reason !== 'handshake') console.warn(`[IMessageConnector] Discarding relayed delivery ${event.id}: ${check.reason}`)
      return 'discard'
    }
    const outcome = await this.receive(check.delivery, 'relay')
    return outcome === 'ignored' ? 'discard' : relayAcceptResult(outcome)
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private report(error: unknown, operation: string): void {
    console.error(`[IMessageConnector] ${operation} failed:`, error)
    captureException(error, { tags: { component: 'chat-integration', operation }, extra: { integrationId: this.integration?.id } })
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private async sendTextAndReturn(text: string, targetChatId?: string): Promise<string> {
    return await this.postMessage(targetChatId, [{ type: 'text', value: text }]) ?? `msg-${Date.now()}`
  }

  // ── Gateway commands: over HTTP with webhooks, over the socket otherwise ──

  /** Resolves to Linq's id for the message when the gateway says, which it does over HTTP. */
  private async postMessage(chatId: string | undefined, parts: GatewayMessagePart[], decorations: GatewayTextDecoration[] = []): Promise<string | null> {
    const message = { chatId, parts, ...(decorations.length > 0 && { textDecorations: decorations }) }
    if (this.mode === 'webhooks') return (await sendGatewayMessage(this.config, message)).messageId
    this.send({ type: 'send_message', data: message })
    return null
  }

  /** A tapback name, or one emoji, sent as a custom tapback. */
  private react(messageId: string, reaction: string): void {
    const tapback = isSingleEmoji(reaction) ? { reactionType: 'custom', customEmoji: reaction } : { reactionType: reaction }
    if (this.mode !== 'webhooks') {
      this.send({ type: 'send_reaction', data: { messageId, operation: 'add', ...tapback, partIndex: 0 } })
      return
    }
    background(sendGatewayReaction(this.config, { messageId, ...tapback, partIndex: 0 })
      .catch(error => console.warn('[IMessageConnector] Reaction not sent:', error)), { name: 'imessage-connector.send-reaction' })
  }

  private startTyping(chatId: string): void {
    if (this.mode !== 'webhooks') {
      this.send({ type: 'start_typing', data: { chatId } })
      return
    }
    background(startGatewayTyping(this.config, chatId).catch(error => console.warn('[IMessageConnector] Typing indicator not shown:', error)), { name: 'imessage-connector.start-typing' })
  }

  /** Once the host accepts a message: "Read" in a 1:1 chat, 👀 in a group, where iMessage shows no read receipts. */
  override async acknowledgeInput(event: IntegrationInputEvent): Promise<void> {
    const message = incomingMessageSchema.parse(event.payload)
    const chatId = message.chatId
    if (classifyIMessageChat(message) !== 'group') { this.markRead(chatId); return }
    // 👀 says the agent will start on it, so a command that starts no turn (/clear) gets none.
    if (this.resolveRoute(event).action !== 'run') { this.cancelGroupAck(chatId); return }
    // One 👀 per burst (like a backlog), on the newest accepted message, within the gateway's rate limit.
    const at = message.timestamp.getTime()
    const pending = this.groupAcks.get(chatId)
    if (pending) {
      if (!(at < pending.at)) Object.assign(pending, { messageId: message.externalMessageId, at })
      return
    }
    const ack = { messageId: message.externalMessageId, at, timer: setTimeout(() => {
      this.groupAcks.delete(chatId)
      this.react(ack.messageId, '👀')
    }, IMessageConnector.READ_RECEIPT_DELAY_MS) }
    this.groupAcks.set(chatId, ack)
  }

  /** The agent's own reaction replaces the received mark, so a pending 👀 must not land after it. */
  private cancelGroupAck(chatId: string): void {
    const pending = this.groupAcks.get(chatId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.groupAcks.delete(chatId)
  }

  /** Over HTTP, one receipt per chat for a burst of messages (like a backlog), within the gateway's rate limit. */
  private markRead(chatId: string): void {
    if (this.mode !== 'webhooks') {
      this.send({ type: 'mark_read', data: { chatId } })
      return
    }
    if (this.readReceipts.has(chatId)) return
    this.readReceipts.set(chatId, setTimeout(() => {
      this.readReceipts.delete(chatId)
      background(markGatewayChatRead(this.config, chatId).catch(error => console.warn('[IMessageConnector] Read receipt not sent:', error)), { name: 'imessage-connector.mark-read' })
    }, IMessageConnector.READ_RECEIPT_DELAY_MS))
  }

  private requestUpload(file: { filename: string; contentType: string; sizeBytes: number }): Promise<GatewayUpload> {
    if (this.mode === 'webhooks') return requestGatewayUpload(this.config, file)
    const uploadId = `upload-${this.nextUploadId++}`
    const upload = new Promise<GatewayUpload>((resolve, reject) => {
      this.uploadResolvers.set(uploadId, resolve)
      setTimeout(() => {
        this.uploadResolvers.delete(uploadId)
        reject(new Error('Upload attachment response timeout'))
      }, 30_000)
    })
    this.send({ type: 'upload_attachment', data: file })
    return upload
  }

  private startPingLoop(): void {
    this.stopPingLoop()
    this.pongReceived = true
    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

      if (!this.pongReceived) {
        console.log('[IMessageConnector] Pong timeout — closing stale connection')
        this.ws.terminate()
        return
      }

      this.pongReceived = false
      this.ws.ping()
    }, IMessageConnector.PING_INTERVAL_MS)
  }

  private stopPingLoop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private scheduleReconnect(): void {
    if (this.disconnecting) return

    this.stopPingLoop()
    this.reconnectAttempts++
    const delay = Math.min(
      IMessageConnector.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      IMessageConnector.MAX_RECONNECT_DELAY_MS,
    )

    console.log(`[IMessageConnector] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
    this.reconnectTimer = setTimeout(() => {
      if (this.disconnecting) return
      background(this.doConnect().catch((err) => {
        console.error('[IMessageConnector] Reconnect failed:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'imessage-reconnect' } })
        this.emitError(err instanceof Error ? err : new Error(String(err)))
        this.scheduleReconnect()
      }), { name: 'imessage-connector.reconnect' })
    }, delay)
  }
}

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    txt: 'text/plain', json: 'application/json', csv: 'text/csv', vcf: 'text/vcard',
    zip: 'application/zip',
  }
  return (ext && map[ext]) || 'application/octet-stream'
}
