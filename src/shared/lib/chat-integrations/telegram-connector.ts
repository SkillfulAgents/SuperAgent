/**
 * TelegramConnector — Telegram Bot API integration via grammY.
 *
 * Uses long polling (no webhooks) for Electron compatibility.
 * Supports streaming via editMessageText with throttling.
 * User request cards rendered as inline keyboards.
 */

import { Bot, type Context as GrammyContext } from 'grammy'
import { Marked, Renderer } from 'marked'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import { ChatClientConnector, type OutgoingMessage } from './base-connector'
import { captureException } from '@shared/lib/error-reporting'

// ── Config ──────────────────────────────────────────────────────────────

export interface TelegramConfig {
  botToken: string
  chatId?: string
}

// ── Telegram limits ─────────────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 4096
const FIRST_POLL_BATCH_DELAY_MS = 500

// ── Markdown → Telegram HTML ─────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const telegramMarked = new Marked({ async: false, gfm: true })

/**
 * Convert Markdown to Telegram-compatible HTML using `marked`.
 * Telegram supports: <b>, <i>, <u>, <s>, <strong>, <em>, <code>, <pre>, <a>, <blockquote>
 * Everything else is stripped or converted to supported equivalents.
 */
export function markdownToTelegramHtml(md: string): string {
  const renderer = new Renderer()

  // Block-level: replace unsupported tags with Telegram equivalents
  renderer.heading = ({ tokens }) => `<b>${telegramMarked.parser(tokens)}</b>\n\n`
  renderer.code = ({ text }) => `<pre>${escapeHtml(text)}</pre>\n`
  renderer.hr = () => '\n---\n'
  renderer.html = ({ text }) => escapeHtml(text)

  // List: render manually since <ul>/<li> aren't supported
  renderer.list = (token) => {
    const items = token.items.map((item, i) => {
      const bullet = token.ordered ? `${(token.start || 1) + i}. ` : '• '
      return `${bullet}${telegramMarked.parser(item.tokens)}`
    })
    return items.join('\n') + '\n\n'
  }

  // Table: render as aligned monospace text since Telegram has no table support
  renderer.table = (token) => {
    // Use plain text for table cells (strip all formatting — it's inside <pre> anyway)
    const cellText = (cell: { text: string }) => cell.text
    const headers = token.header.map(cellText)
    const rows = token.rows.map((row: Array<{ text: string }>) =>
      row.map(cellText)
    )
    const allRows = [headers, ...rows]
    const colWidths = headers.map((_: string, col: number) =>
      Math.max(...allRows.map(r => (r[col] || '').length))
    )
    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length))
    const formatRow = (row: string[]) => row.map((cell, i) => pad(cell, colWidths[i])).join('  ')

    let out = `<pre>${formatRow(headers)}\n`
    out += colWidths.map((w: number) => '-'.repeat(w)).join('  ') + '\n'
    for (const row of rows) {
      out += formatRow(row) + '\n'
    }
    out += '</pre>\n\n'
    return out
  }

  telegramMarked.use({ renderer })
  const result = telegramMarked.parse(md) as string

  return result
    // Strip any remaining unsupported HTML tags, keep only Telegram-supported ones
    .replace(/<\/?(?!(?:b|i|u|s|strong|em|del|code|pre|a|blockquote)\b)[a-z][^>]*>/gi, '')
    // Strip <p> tags
    .replace(/<p>/g, '')
    .replace(/<\/p>/g, '\n\n')
    // Clean up excessive newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Connector ───────────────────────────────────────────────────────────

export class TelegramConnector extends ChatClientConnector {
  readonly provider = 'telegram' as const

  private bot: Bot | null = null
  private connected = false
  private disconnecting = false
  private hasCompletedFirstPoll = false
  private startupError: Error | null = null

  // First-poll batching: accumulate messages before sending them all at once
  private pendingFirstPollMessages: Map<string, { texts: string[]; timer: ReturnType<typeof setTimeout> | null }> = new Map()

  // Track callback_query toolUseId mappings (Telegram callback_data is limited to 64 bytes)
  private callbackDataMap: Map<string, { toolUseId: string; value: unknown; ts: number }> = new Map()
  private nextCallbackId = 0
  private static readonly CALLBACK_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

  // Track pending multi-question requests: accumulate answers until all questions are answered
  private pendingQuestions: Map<string, {
    totalQuestions: number
    answers: Record<string, string> // { questionText: selectedAnswer }
  }> = new Map()

  constructor(private config: TelegramConfig) {
    super()
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.disconnecting = false
    this.startupError = null
    this.bot = new Bot(this.config.botToken)

    // Handle text messages
    this.bot.on('message:text', (ctx) => this.handleTextMessage(ctx))

    // Handle callback queries (inline keyboard button clicks)
    this.bot.on('callback_query:data', async (ctx) => {
      await ctx.answerCallbackQuery()
      const data = ctx.callbackQuery.data
      const mapping = this.callbackDataMap.get(data)
      if (mapping) {
        const val = mapping.value as { question: string; answer: string }

        // Update the message to show the selected answer and remove the keyboard
        const originalText = ctx.callbackQuery.message?.text || ''
        try {
          await ctx.editMessageText(`${originalText}\n\n✅ <b>${this.escapeHtml(val.answer)}</b>`, {
            parse_mode: 'HTML',
          })
        } catch {
          try { await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }) } catch { /* ignore */ }
        }

        this.callbackDataMap.delete(data)

        // Accumulate answer for multi-question requests
        const pending = this.pendingQuestions.get(mapping.toolUseId)
        if (pending) {
          pending.answers[val.question] = val.answer
          if (Object.keys(pending.answers).length >= pending.totalQuestions) {
            // All questions answered — emit the combined response
            this.emitInteractiveResponse(mapping.toolUseId, {
              question: '_all',
              answer: '_all',
              answers: pending.answers,
            })
            this.pendingQuestions.delete(mapping.toolUseId)
          }
        } else {
          // Single question — emit immediately
          this.emitInteractiveResponse(mapping.toolUseId, mapping.value)
        }
      }
    })

    // Handle photo messages (images sent directly, not as documents)
    this.bot.on('message:photo', async (ctx) => {
      const photos = ctx.message.photo
      if (!photos || photos.length === 0) return

      // Use the largest photo version (last in array)
      const largest = photos[photos.length - 1]
      const chatId = String(ctx.chat.id)
      let url = ''
      try {
        const file = await this.bot!.api.getFile(largest.file_id)
        url = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`
      } catch { /* fallback to file_id */ }

      const userName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || ctx.from?.username || undefined

      this.emitMessage({
        externalMessageId: String(ctx.message.message_id),
        text: ctx.message.caption || '',
        chatId,
        userId: String(ctx.from?.id || ''),
        userName,
        chatName: (ctx.chat as any).title || userName || undefined,
        files: [{
          name: 'photo.jpg',
          url,
          mimeType: 'image/jpeg',
        }],
        timestamp: new Date(ctx.message.date * 1000),
      })
    })

    // Handle document uploads (for file request resolution)
    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document
      const chatId = String(ctx.chat.id)
      let url = ''
      try {
        const file = await this.bot!.api.getFile(doc.file_id)
        url = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`
      } catch { /* fallback */ }

      const userName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || ctx.from?.username || undefined

      this.emitMessage({
        externalMessageId: String(ctx.message.message_id),
        text: ctx.message.caption || '',
        chatId,
        userId: String(ctx.from?.id || ''),
        userName,
        chatName: (ctx.chat as any).title || userName || undefined,
        files: [{
          name: doc.file_name || 'file',
          url,
          mimeType: doc.mime_type,
        }],
        timestamp: new Date(ctx.message.date * 1000),
      })
    })

    // Start long polling
    // Use runner pattern: bot.start() returns a promise that resolves once
    // the first getUpdates succeeds (proving the token is valid)
    // A rejection here (e.g. grammY 409 Conflict from duplicate pollers) must
    // be caught — otherwise it bubbles up to process.unhandledRejection and
    // crashes the Electron app.
    this.bot.start({
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
      onStart: () => {
        this.connected = true
        // Mark first poll complete after a short delay
        // (allows batching of queued messages)
        setTimeout(() => {
          this.hasCompletedFirstPoll = true
          this.flushAllPendingBatches()
        }, FIRST_POLL_BATCH_DELAY_MS * 2)
        console.log('[TelegramConnector] Long polling started')
      },
    }).catch((err) => {
      if (this.disconnecting) return
      const error = err instanceof Error ? err : new Error(String(err))
      this.connected = false
      this.startupError = error
      captureException(error, {
        tags: { component: 'chat-integration', operation: 'telegram-polling' },
        extra: { provider: 'telegram' },
      })
      this.emitError(error)
    })

    // Wait briefly to verify connection. Short-circuit if polling rejected
    // early (e.g. invalid token, 409 Conflict) — no need to wait 10s in that case.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Telegram connection timeout')), 10000)
      const check = setInterval(() => {
        if (this.connected) {
          clearInterval(check)
          clearTimeout(timeout)
          resolve()
        } else if (this.startupError) {
          clearInterval(check)
          clearTimeout(timeout)
          reject(this.startupError)
        }
      }, 100)
    })
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true
    this.connected = false
    this.hasCompletedFirstPoll = false

    // Flush any pending batches
    this.flushAllPendingBatches()
    this.callbackDataMap.clear()
    this.pendingQuestions.clear()

    if (this.bot) {
      await this.bot.stop()
      this.bot = null
    }
    console.log('[TelegramConnector] Disconnected')
  }

  isConnected(): boolean {
    return this.connected
  }

  // ── Message sending ─────────────────────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected')

    const html = this.markdownToHtml(message.text || '(empty message)')
    const chunks = this.splitMessage(html)

    let lastMessageId = ''
    for (const chunk of chunks) {
      const sent = await this.bot.api.sendMessage(chatId, chunk, {
        parse_mode: 'HTML',
        ...(message.replyToExternalId ? { reply_parameters: { message_id: Number(message.replyToExternalId) } } : {}),
      })
      lastMessageId = String(sent.message_id)
    }
    return lastMessageId
  }

  async sendFile(chatId: string, fileData: Buffer, filename: string, caption?: string): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected')
    const { InputFile } = await import('grammy')
    const result = await this.bot.api.sendDocument(
      chatId,
      new InputFile(new Uint8Array(fileData), filename),
      caption ? { caption } : undefined,
    )
    return String(result.message_id)
  }

  async sendStreamingUpdate(chatId: string, text: string, existingMessageId?: string): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected')

    const truncated = text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH - 20) + '\n\n... (truncated)'
      : text
    const displayText = this.markdownToHtml(truncated || 'Thinking...')

    if (!existingMessageId) {
      // First chunk — create the message
      const sent = await this.bot.api.sendMessage(chatId, displayText, { parse_mode: 'HTML' })
      return String(sent.message_id)
    }

    // Edit existing message
    try {
      await this.bot.api.editMessageText(chatId, Number(existingMessageId), displayText, {
        parse_mode: 'HTML',
      })
    } catch (err: unknown) {
      // "message is not modified" is expected when text hasn't changed
      const errMsg = err instanceof Error ? err.message : String(err)
      if (!errMsg.includes('message is not modified')) {
        throw err
      }
    }
    return existingMessageId
  }

  async finalizeStreamingMessage(chatId: string, messageId: string, finalText: string): Promise<void> {
    if (!this.bot) return

    const truncated = finalText.length > MAX_MESSAGE_LENGTH
      ? finalText.slice(0, MAX_MESSAGE_LENGTH - 20) + '\n\n... (truncated)'
      : finalText

    try {
      await this.bot.api.editMessageText(chatId, Number(messageId), this.markdownToHtml(truncated || '(empty response)'), {
        parse_mode: 'HTML',
      })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (!errMsg.includes('message is not modified')) {
        console.error('[TelegramConnector] Failed to finalize message:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'finalize-message' }, extra: { provider: 'telegram', chatId, messageId } })
      }
    }
  }

  async showTypingIndicator(chatId: string): Promise<void> {
    if (!this.bot) return
    try {
      await this.bot.api.sendChatAction(chatId, 'typing')
    } catch {
      // Non-critical
    }
  }

  // ── User request cards ──────────────────────────────────────────────

  async sendUserRequestCard(chatId: string, event: UserRequestEvent): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected')

    switch (event.type) {
      case 'user_question_request': {
        let lastMessageId = ''

        // Track multi-question requests so we wait for all answers
        if (event.questions.length > 1) {
          this.pendingQuestions.set(event.toolUseId, {
            totalQuestions: event.questions.length,
            answers: {},
          })
        }

        // Send each question as its own message with its own keyboard
        for (const q of event.questions) {
          const header = q.header ? `<b>${this.escapeHtml(q.header)}</b>\n` : ''
          const text = `${header}${this.escapeHtml(q.question)}`

          const keyboard: Array<Array<{ text: string; callback_data: string }>> = []
          if (q.options && q.options.length > 0) {
            for (const opt of q.options) {
              // Store the full answer payload: { question, answer }
              const cbId = this.registerCallback(event.toolUseId, {
                question: q.question,
                answer: opt.label,
              })
              keyboard.push([{ text: opt.label, callback_data: cbId }])
            }
          }

          const sent = await this.bot.api.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            ...(keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
          })
          lastMessageId = String(sent.message_id)
        }

        return lastMessageId
      }

      case 'secret_request': {
        const text = `<b>Secret requested:</b> <code>${this.escapeHtml(event.secretName)}</code>\n${event.reason ? `\nReason: ${this.escapeHtml(event.reason)}` : ''}\n\nPlease reply with the secret value.`
        const sent = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' })
        return String(sent.message_id)
      }

      case 'file_request': {
        const text = `<b>File requested:</b>\n${this.escapeHtml(event.description)}${event.fileTypes ? `\n\nAccepted types: ${this.escapeHtml(event.fileTypes)}` : ''}\n\nPlease upload the file.`
        const sent = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' })
        return String(sent.message_id)
      }

      case 'file_delivery': {
        // File transfer from container to chat is not yet supported — show metadata only
        const text = `<b>File delivered:</b> <code>${this.escapeHtml(event.filePath)}</code>${event.description ? `\n${this.escapeHtml(event.description)}` : ''}\n\n<i>File download not yet supported — view in the app.</i>`
        const sent = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' })
        return String(sent.message_id)
      }

      case 'tool_status': {
        const emoji = event.status === 'success' ? '✅' : event.status === 'error' ? '❌' : event.status === 'cancelled' ? '⛔' : '⏳'
        const text = `🔧 <b>${this.escapeHtml(event.toolName)}</b> — ${this.escapeHtml(event.summary)} ${emoji}`
        const sent = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' })
        return String(sent.message_id)
      }

      default: {
        // Generic card for other event types
        const text = `<b>${this.escapeHtml(event.type)}</b>\n<pre>${this.escapeHtml(JSON.stringify(event, null, 2).slice(0, 3000))}</pre>`
        const sent = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' })
        return String(sent.message_id)
      }
    }
  }

  // ── First-poll batching ─────────────────────────────────────────────

  private handleTextMessage(ctx: GrammyContext): void {
    const text = ctx.message?.text
    if (!text || !ctx.chat) return

    // Handle /start command — greet the user instead of forwarding to the agent
    if (text === '/start') {
      ctx.reply('Hello! Send me a message and I\'ll forward it to your agent.').catch(() => {})
      return
    }

    const chatId = String(ctx.chat.id)
    const fromId = String(ctx.from?.id || '')
    const messageId = String(ctx.message?.message_id || '')
    const userName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ')
      || ctx.from?.username
      || undefined
    // For groups/channels use the chat title; for DMs use the user's name
    const chatName = (ctx.chat as any).title || userName || undefined

    if (!this.hasCompletedFirstPoll) {
      // Buffer messages during first poll
      let pending = this.pendingFirstPollMessages.get(chatId)
      if (!pending) {
        pending = { texts: [], timer: null }
        this.pendingFirstPollMessages.set(chatId, pending)
      }
      pending.texts.push(text)

      if (pending.timer) clearTimeout(pending.timer)
      pending.timer = setTimeout(() => {
        if (!this.disconnecting) this.flushBatch(chatId, fromId, messageId)
      }, FIRST_POLL_BATCH_DELAY_MS)
      return
    }

    // Normal flow: forward immediately
    this.emitMessage({
      externalMessageId: messageId,
      text,
      chatId,
      userId: fromId,
      userName,
      chatName,
      timestamp: new Date((ctx.message?.date || 0) * 1000),
    })
  }

  private flushBatch(chatId: string, userId: string, lastMessageId: string): void {
    const pending = this.pendingFirstPollMessages.get(chatId)
    if (!pending || pending.texts.length === 0) return

    const combined = pending.texts.join('\n\n---\n\n')
    this.emitMessage({
      externalMessageId: lastMessageId,
      text: combined,
      chatId,
      userId,
      timestamp: new Date(),
    })
    this.pendingFirstPollMessages.delete(chatId)
  }

  private flushAllPendingBatches(): void {
    for (const [chatId, pending] of this.pendingFirstPollMessages) {
      if (pending.timer) clearTimeout(pending.timer)
      if (pending.texts.length > 0) {
        this.flushBatch(chatId, '', '0')
      }
    }
    this.pendingFirstPollMessages.clear()
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private registerCallback(toolUseId: string, value: unknown): string {
    // Evict stale callbacks to prevent unbounded growth
    const now = Date.now()
    for (const [key, entry] of this.callbackDataMap) {
      if (now - entry.ts > TelegramConnector.CALLBACK_TTL_MS) {
        this.callbackDataMap.delete(key)
      }
    }
    const id = `cb_${this.nextCallbackId++}`
    this.callbackDataMap.set(id, { toolUseId, value, ts: now })
    return id
  }

  private escapeHtml(text: string): string {
    return escapeHtml(text)
  }

  private markdownToHtml(md: string): string {
    return markdownToTelegramHtml(md)
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text]

    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining)
        break
      }
      // Try to split at paragraph boundary
      let splitAt = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH)
      if (splitAt === -1 || splitAt < MAX_MESSAGE_LENGTH / 2) {
        splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH)
      }
      if (splitAt === -1 || splitAt < MAX_MESSAGE_LENGTH / 2) {
        splitAt = MAX_MESSAGE_LENGTH
      }
      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).trimStart()
    }
    return chunks
  }
}
