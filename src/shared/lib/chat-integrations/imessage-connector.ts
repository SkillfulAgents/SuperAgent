/**
 * IMessageConnector — iMessage integration via the iMessage Gateway service.
 *
 * Connects to the gateway over WebSocket. No streaming (iMessage has a 5-edit
 * limit) — shows typing indicator while the agent works, then sends the
 * complete message. Approvals use tapback reactions; questions use plain text.
 */

import WebSocket from 'ws'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import type { SessionActivity } from '@shared/lib/types/agent'
import { ChatClientConnector, type OutgoingMessage } from './base-connector'
import { describeUnsupportedRequest, isUnsupportedInChat, withSessionUrl, type AppLinkContext } from './utils'
import { captureException } from '@shared/lib/error-reporting'

// ── Config ──────────────────────────────────────────────────────────────

export interface IMessageConfig {
  gatewayUrl: string
  phoneNumber: string
  token: string
}

// ── Reaction tag parsing ────────────────────────────────────────────────

const REACTION_TAG_RE = /\[\[reaction:(\w+)\]\]/g

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

// ── Session system prompt ───────────────────────────────────────────────

const IMESSAGE_SYSTEM_PROMPT = `This is an iMessage-based conversation. Follow these rules:
- Keep responses concise and conversational — this is a text message, not a document.
- Use tools, skills, and capabilities as you normally would.
- Prefer asking questions directly in natural language rather than using the ask questions tool.
- You can react to the user's last message by starting your response with a reaction tag. Available reactions: [[reaction:heart]], [[reaction:thumbs_up]], [[reaction:thumbs_down]], [[reaction:haha]], [[reaction:emphasize]], [[reaction:question]]. The tag will be stripped from the message and sent as a tapback reaction. If your entire response is just a reaction tag, only the reaction is sent (no text message).
- The user may send voice notes which are automatically transcribed.`

// ── Connector ───────────────────────────────────────────────────────────

export class IMessageConnector extends ChatClientConnector {
  readonly provider = 'imessage' as const

  static generateSystemPrompt = () => IMESSAGE_SYSTEM_PROMPT

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

  private lastReceivedMessageId: string | null = null
  private lastChatId: string | null = null
  // Chats currently showing the typing bubble. The manager's tick calls startWorking
  // every ~1s for keep-alive; iMessage's bubble self-expires, so we send start_typing
  // once per working segment (on the not-shown→shown edge) instead of on every tick.
  private typingShown: Set<string> = new Set()
  private pendingApprovals: Map<string, PendingApproval> = new Map()
  private pendingQuestions: Map<string, PendingQuestion> = new Map()

  // Track message.sent confirmations for upload flow
  private sentMessageResolvers: Map<string, (messageId: string) => void> = new Map()
  private uploadResolvers: Map<string, (data: { attachmentId: string; uploadUrl: string; downloadUrl: string; requiredHeaders: Record<string, string> }) => void> = new Map()
  private nextUploadId = 0
  private nextApprovalId = 0

  constructor(private config: IMessageConfig, private appLink?: AppLinkContext) {
    super()
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.disconnecting = false
    this.reconnectAttempts = 0

    await this.doConnect()
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
        this.send({ type: 'ready' })
      })

      this.ws.on('pong', () => {
        this.pongReceived = true
      })

      this.ws.on('message', (raw) => {
        try {
          const event = JSON.parse(raw.toString())
          if (!resolved && event.type === 'connected') {
            resolved = true
            clearTimeout(timeout)
            this._connected = true
            this.reconnectAttempts = 0
            this.startPingLoop()
            console.log(`[IMessageConnector] Connected (${event.data?.queuedCount ?? 0} queued events)`)
            resolve()
          }
          this.handleServerEvent(event)
        } catch (err) {
          console.error('[IMessageConnector] Failed to parse server message:', err)
        }
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
    console.log('[IMessageConnector] Disconnected')
  }

  isConnected(): boolean {
    return this._connected
  }

  // ── Message sending ─────────────────────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<string> {
    const text = message.text || ''
    const targetChatId = chatId || this.lastChatId || undefined

    // Parse and handle reaction tags
    const { cleanText, reactions } = this.extractReactions(text)

    // Send reactions to the user's last message
    if (reactions.length > 0 && this.lastReceivedMessageId) {
      for (const reactionType of reactions) {
        this.send({
          type: 'send_reaction',
          data: {
            messageId: this.lastReceivedMessageId,
            operation: 'add',
            reactionType,
            partIndex: 0,
          },
        })
      }
    }

    // If only reactions, no text to send
    if (!cleanText.trim()) {
      return `reaction-only-${Date.now()}`
    }

    this.send({
      type: 'send_message',
      data: { chatId: targetChatId, parts: [{ type: 'text', value: cleanText }] },
    })

    return `msg-${Date.now()}`
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
    this.send({ type: 'start_typing', data: { chatId: targetChatId } })
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

    try {
      // 1. Request upload URL
      const uploadId = `upload-${this.nextUploadId++}`
      const uploadPromise = new Promise<{
        attachmentId: string
        uploadUrl: string
        requiredHeaders: Record<string, string>
      }>((resolve, reject) => {
        this.uploadResolvers.set(uploadId, resolve as any)
        setTimeout(() => {
          this.uploadResolvers.delete(uploadId)
          reject(new Error('Upload attachment response timeout'))
        }, 30_000)
      })

      this.send({
        type: 'upload_attachment',
        data: { filename, contentType: mimeType, sizeBytes: fileData.length },
      })

      const uploadInfo = await uploadPromise

      // 2. Upload the file
      const uploadRes = await fetch(uploadInfo.uploadUrl, {
        method: 'PUT',
        headers: uploadInfo.requiredHeaders,
        body: new Uint8Array(fileData),
      })
      if (!uploadRes.ok) {
        throw new Error(`File upload failed: ${uploadRes.status}`)
      }

      // 3. Send message with attachment
      const parts: Array<{ type: string; attachmentId?: string; value?: string }> = [
        { type: 'media', attachmentId: uploadInfo.attachmentId },
      ]
      if (caption) {
        parts.push({ type: 'text', value: caption })
      }

      this.send({ type: 'send_message', data: { chatId: targetChatId, parts } })
      return `file-${Date.now()}`
    } catch (err) {
      console.error('[IMessageConnector] Failed to send file:', err)
      captureException(err, { tags: { component: 'chat-integration', operation: 'imessage-send-file' } })
      // Fall back to a text message about the file
      this.send({
        type: 'send_message',
        data: { chatId: targetChatId, parts: [{ type: 'text', value: `[File: ${filename}]${caption ? ` — ${caption}` : ''}` }] },
      })
      return `file-fallback-${Date.now()}`
    }
  }

  // ── User request cards ──────────────────────────────────────────────

  async sendUserRequestCard(chatId: string, event: UserRequestEvent, sessionId?: string): Promise<string> {
    const appLink = withSessionUrl(this.appLink, sessionId)
    const targetChatId = chatId || this.lastChatId || undefined
    if (isUnsupportedInChat(event)) {
      return this.sendTextAndReturn(describeUnsupportedRequest(event, appLink), targetChatId)
    }

    switch (event.type) {
      case 'user_question_request': {
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

  private sendApprovalCard(event: UserRequestEvent, targetChatId?: string): string {
    const questions = (event as any).questions as Array<{ question: string }> | undefined
    const displayText = questions?.[0]?.question || 'Allow this action?'
    const text = `${displayText}\n\nReact with 👍 to allow, 👎 to deny.`

    const messageId = `approval-${this.nextApprovalId++}`
    this.send({
      type: 'send_message',
      data: { chatId: targetChatId, parts: [{ type: 'text', value: text }] },
    })

    this.pendingApprovals.set(messageId, {
      toolUseId: event.toolUseId,
      sentMessageId: messageId,
    })

    return messageId
  }

  private sendQuestionCard(event: UserRequestEvent, targetChatId?: string): string {
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
    this.send({
      type: 'send_message',
      data: { chatId: targetChatId, parts: [{ type: 'text', value: text }] },
    })

    this.pendingQuestions.set(event.toolUseId, {
      toolUseId: event.toolUseId,
      questions: questions.map(q => ({
        question: q.question,
        options: q.options || [],
      })),
    })

    return `question-${Date.now()}`
  }

  // ── Server event handling ────────────────────────────────────────────

  private handleServerEvent(event: { type: string; data?: any }): void {
    switch (event.type) {
      case 'connected':
        // Already handled in doConnect
        break

      case 'message.received':
        this.handleMessageReceived(event.data)
        break

      case 'reaction.added':
        this.handleReactionAdded(event.data)
        break

      case 'message.sent':
        this.handleMessageSent(event.data)
        break

      case 'upload_attachment.response':
        this.handleUploadResponse(event.data)
        break

      case 'message.failed':
        console.error('[IMessageConnector] Message delivery failed:', event.data)
        break

      case 'error': {
        const msg = event.data?.message || 'unknown'
        console.error('[IMessageConnector] Gateway error:', event.data)
        if (/typing indicators are not supported/i.test(msg)) break
        this.emitError(new Error(`Gateway error: ${msg}`))
        break
      }

      case 'typing.started':
        this.emitTypingHint(this.config.phoneNumber)
        break

      // Ignored events: message.delivered, message.read, typing.stopped, message.edited, reaction.removed
    }
  }

  private handleMessageReceived(data: any): void {
    if (!data) return

    const messageId = data.messageId as string
    const chatId = data.chatId as string || this.config.phoneNumber
    const chatName = data.chatName as string | undefined
    const from = data.from as string
    const parts = data.parts as Array<{ type: string; value?: string; url?: string; mimeType?: string; filename?: string; sizeBytes?: number }> || []
    const sentAt = data.sentAt ? new Date(data.sentAt) : new Date()

    this.lastReceivedMessageId = messageId
    this.lastChatId = chatId

    // Send read receipt immediately
    this.send({ type: 'mark_read', data: { chatId } })

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
      this.resolveNextQuestion(text)
      // Don't emit as a regular message — it's an answer to a question
      return
    }

    // Check if there are pending approvals — deny them all and forward message
    if (this.pendingApprovals.size > 0) {
      this.denyAllPendingApprovals()
      // Fall through to emit the message normally
    }

    this.emitMessage({
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

  private handleReactionAdded(data: any): void {
    if (!data) return
    const reactionType = data.reactionType as string

    // Check if this reaction is on a pending approval message
    for (const [key, approval] of this.pendingApprovals) {
      // Match any pending approval (we can't perfectly match messageId since we
      // use synthetic IDs, but the gateway will have the real one)
      if (APPROVAL_ALLOW_REACTIONS.has(reactionType)) {
        this.emitInteractiveResponse(approval.toolUseId, {
          question: '_approval',
          answer: '✅ Allow',
        })
        this.pendingApprovals.delete(key)
        return
      }
      if (APPROVAL_DENY_REACTIONS.has(reactionType)) {
        this.emitInteractiveResponse(approval.toolUseId, {
          question: '_approval',
          answer: '❌ Deny',
        })
        this.pendingApprovals.delete(key)
        return
      }
    }
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
      const mapped = REACTION_NAME_TO_TYPE[name.toLowerCase()]
      if (mapped) reactions.push(mapped)
      return ''
    })
    return { cleanText: cleanText.trim(), reactions }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private sendTextAndReturn(text: string, targetChatId?: string): string {
    this.send({
      type: 'send_message',
      data: { chatId: targetChatId, parts: [{ type: 'text', value: text }] },
    })
    return `msg-${Date.now()}`
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
      this.doConnect().catch((err) => {
        console.error('[IMessageConnector] Reconnect failed:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'imessage-reconnect' } })
        this.emitError(err instanceof Error ? err : new Error(String(err)))
        this.scheduleReconnect()
      })
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
    txt: 'text/plain', json: 'application/json', csv: 'text/csv',
    zip: 'application/zip',
  }
  return (ext && map[ext]) || 'application/octet-stream'
}
