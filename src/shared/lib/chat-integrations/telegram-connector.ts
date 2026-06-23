/**
 * TelegramConnector — Telegram Bot API integration via grammY.
 *
 * Uses long polling (no webhooks) for Electron compatibility.
 * Streams Bot API 10.1 rich messages: animated sendRichMessageDraft in DMs,
 * throttled sendRichMessage + editMessageText in groups, with a markdownToTelegramHtml
 * fallback for the rich-send error path and the richMessages rollback flag.
 * User request cards rendered as inline keyboards.
 */

import { Bot, type Context as GrammyContext } from 'grammy'
import { Marked, Renderer } from 'marked'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import { ChatClientConnector, type OutgoingMessage } from './base-connector'
import { describeUnsupportedRequest, isUnsupportedInChat } from './utils'
import { captureException } from '@shared/lib/error-reporting'
import { markdownToRichMessage, splitForRichLimits, splitForHtmlLimits, escapeMarkdown, codeSpan } from './telegram-rich-message'
import type { InputRichMessage } from 'grammy/types'
import { getPlatformBaseUrl } from '@shared/lib/platform-auth/config'

// ── Config ──────────────────────────────────────────────────────────────

export interface TelegramConfig {
  botToken: string
  chatId?: string
  richMessages?: boolean
  draftStreaming?: boolean
  skipEntityDetection?: boolean
}

// ── Telegram limits ─────────────────────────────────────────────────────

const FIRST_POLL_BATCH_DELAY_MS = 500
const RICH_DRAFT_SENTINEL_PREFIX = 'draft:'
// Telegram's "working" indicators are ephemeral — rich drafts expire ~30s, the
// typing action ~5s — so startWorking re-sends on this heartbeat until the
// response takes over. ~1s stays within Telegram's per-chat send cadence.
const WORKING_REFRESH_MS = 1000

// ── Markdown → Telegram HTML ─────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Icon shown before the dashboard name when the agent supplies no emoji. */
const DASHBOARD_DEFAULT_EMOJI = '📊'

/** Resolve the card's icon: the agent's emoji if given, else the default. */
export function resolveDashboardEmoji(emoji?: string): string {
  return emoji?.trim() || DASHBOARD_DEFAULT_EMOJI
}

/**
 * Render the dashboard share card body as markdown: a bold "<emoji> <name>"
 * title with an optional italic blurb as a subtitle on its own line. Goes through
 * the same rich-markdown send path as every other outbound message (rich, with an
 * HTML fallback). The agent-supplied emoji/caption and the name are escapeMarkdown'd
 * so they render literally instead of as stray markup. The blurb is separated by a
 * blank line (paragraph break) because Telegram's rich markdown collapses a single
 * newline into a space.
 */
export function renderDashboardCard(name: string, emoji?: string, caption?: string): string {
  const icon = resolveDashboardEmoji(emoji)
  let md = `**${escapeMarkdown(icon)} ${escapeMarkdown(name)}**`
  const blurb = caption?.trim()
  if (blurb) md += `\n\n_${escapeMarkdown(blurb)}_`
  return md
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

/** How a shared dashboard reached the chat: an interactive web_app button, or the plain-text fallback. */
export type DashboardDelivery = 'button' | 'text'

export class TelegramConnector extends ChatClientConnector {
  readonly provider = 'telegram' as const

  private bot: Bot | null = null
  private connected = false
  private disconnecting = false
  private hasCompletedFirstPoll = false
  private startupError: Error | null = null

  // First-poll batching: accumulate messages before sending them all at once
  private pendingFirstPollMessages: Map<string, { texts: string[]; timer: ReturnType<typeof setTimeout> | null; userName?: string; chatName?: string; chatType?: 'private' | 'group' | 'supergroup' }> = new Map()

  // Track callback_query toolUseId mappings (Telegram callback_data is limited to 64 bytes)
  private callbackDataMap: Map<string, { toolUseId: string; value: unknown; ts: number }> = new Map()
  private nextCallbackId = 0
  private static readonly CALLBACK_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

  // Track pending multi-question requests: accumulate answers until all questions are answered
  private pendingQuestions: Map<string, {
    totalQuestions: number
    answers: Record<string, string> // { questionText: selectedAnswer }
  }> = new Map()

  // Animated DM draft streaming: per-chat non-zero draft id.
  private nextDraftId = 1
  private activeDrafts: Map<string, number> = new Map()
  // Keep-alive timers re-sending the "working" indicator, one per chat.
  private workingTimers: Map<string, ReturnType<typeof setInterval>> = new Map()

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
    this.bot.on('callback_query:data', (ctx) => this.handleCallbackQuery(ctx))

    // Handle photo messages (images sent directly, not as documents)
    this.bot.on('message:photo', async (ctx) => {
      const photos = ctx.message.photo
      if (!photos || photos.length === 0) return

      const chatType = ctx.chat.type

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
        chatType: chatType,
        userName,
        chatName: ('title' in ctx.chat ? ctx.chat.title : undefined) || userName || undefined,
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
      const chatType = ctx.chat.type

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
        chatType: chatType,
        userName,
        chatName: ('title' in ctx.chat ? ctx.chat.title : undefined) || userName || undefined,
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
    this.activeDrafts.clear()
    for (const timer of this.workingTimers.values()) clearInterval(timer)
    this.workingTimers.clear()

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

    const chunks = splitForRichLimits(message.text || '(empty message)')
    const replyParams = message.replyToExternalId
      ? { reply_parameters: { message_id: Number(message.replyToExternalId) } }
      : undefined

    let lastMessageId = ''
    for (let i = 0; i < chunks.length; i++) {
      // Only the first chunk carries the reply-to.
      lastMessageId = await this.sendRichOrHtml(chatId, chunks[i], i === 0 ? replyParams : undefined)
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
    const body = text || 'Thinking...'

    // DM animated draft path — only for the streaming-response flow (no real
    // message yet, or an existing draft). A real message id (e.g. a tool-status
    // pill posted via sendMessage) must be edited, not replaced by a new draft.
    if (
      this.useRich &&
      this.config.draftStreaming !== false &&
      this.isPrivateChat(chatId) &&
      (!existingMessageId || existingMessageId.startsWith(RICH_DRAFT_SENTINEL_PREFIX))
    ) {
      return this.driveDraftStream(chatId, body)
    }

    // Group/channel edit path.
    if (!existingMessageId) {
      if (this.useRich) {
        // Via sendRichOrHtml so a rich-send failure falls back to HTML like every
        // other send path, instead of throwing and aborting the stream.
        return this.sendRichOrHtml(chatId, body)
      }
      const sent = await this.bot.api.sendMessage(chatId, this.markdownToHtml(body), { parse_mode: 'HTML' })
      return String(sent.message_id)
    }

    if (this.useRich) {
      await this.editRichOrHtml(chatId, existingMessageId, body)
    } else {
      try {
        await this.bot.api.editMessageText(chatId, Number(existingMessageId), this.markdownToHtml(body), { parse_mode: 'HTML' })
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (!errMsg.includes('message is not modified')) throw err
      }
    }
    return existingMessageId
  }

  async finalizeStreamingMessage(chatId: string, messageId: string, finalText: string): Promise<void> {
    if (!this.bot) return
    const text = finalText || '(empty response)'

    // DM draft path: commit the ephemeral draft as a real persisted message.
    if (messageId.startsWith(RICH_DRAFT_SENTINEL_PREFIX)) {
      await this.commitDraft(chatId, text)
      return
    }

    // Split for the active sink: rich edits hold 32768, but the HTML fallback
    // edit (richMessages rollback, or a rich-edit failure) tops out at 4096. A
    // rich-sized first chunk would blow past the HTML edit limit and the overflow
    // would be silently dropped, so size chunk[0] to whatever this connector edits.
    const chunks = this.useRich ? splitForRichLimits(text) : splitForHtmlLimits(text)
    try {
      await this.editRichOrHtml(chatId, messageId, chunks[0])
      // Overflow chunks are sent whole, not streamed — only chunk[0] (the
      // already-streamed message) animates. Streaming the tail would need a
      // rolling multi-message stream; not worth it for this overflow case.
      for (let i = 1; i < chunks.length; i++) {
        await this.sendRichOrHtml(chatId, chunks[i])
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (!errMsg.includes('message is not modified')) {
        console.error('[TelegramConnector] Failed to finalize message:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'finalize-message' }, extra: { provider: 'telegram', chatId, messageId } })
      }
    }
  }

  private draftIdFor(chatId: string): number {
    let id = this.activeDrafts.get(chatId)
    if (id === undefined) {
      id = this.nextDraftId++
      this.activeDrafts.set(chatId, id)
    }
    return id
  }

  private async driveDraftStream(chatId: string, body: string): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected')
    await this.bot.api.raw.sendRichMessageDraft({
      chat_id: Number(chatId),
      draft_id: this.draftIdFor(chatId),
      rich_message: this.richMessage(body),
    })
    return `${RICH_DRAFT_SENTINEL_PREFIX}${chatId}`
  }

  private async commitDraft(chatId: string, text: string): Promise<void> {
    this.activeDrafts.delete(chatId)
    const chunks = splitForRichLimits(text)
    for (const chunk of chunks) {
      await this.sendRichOrHtml(chatId, chunk)
    }
  }

  async startWorking(chatId: string): Promise<void> {
    if (!this.bot) return
    // Register the keep-alive heartbeat synchronously BEFORE the first awaited send.
    // stopWorking() is fire-and-forget and can run while this initial send is still
    // in flight; if the interval were registered only after the await, that
    // stopWorking would find no timer and this call would install one *after*
    // teardown, leaking "Thinking…" forever. Registering first means a concurrent
    // stopWorking always sees (and clears) the timer. Idempotent: one timer per chat.
    if (!this.workingTimers.has(chatId)) {
      this.workingTimers.set(chatId, setInterval(() => {
        void this.sendWorkingIndicator(chatId)
      }, WORKING_REFRESH_MS))
    }
    await this.sendWorkingIndicator(chatId)
  }

  async stopWorking(chatId: string): Promise<void> {
    const timer = this.workingTimers.get(chatId)
    if (timer) {
      clearInterval(timer)
      this.workingTimers.delete(chatId)
    }
    // The streaming response shares the draft_id and replaces the draft in place,
    // so there is nothing else to tear down.
  }

  /** Post the "working" indicator once: a native draft in rich DMs, else typing. */
  private async sendWorkingIndicator(chatId: string): Promise<void> {
    if (!this.bot) return
    try {
      if (this.useRich && this.config.draftStreaming !== false && this.isPrivateChat(chatId)) {
        // Native Telegram "Thinking…" placeholder (RichBlockThinking / <tg-thinking>).
        // Draft-only, so DM-only. Static ✨: the animated AIActions custom emoji only
        // render when the bot's owner has Telegram Premium (otherwise Telegram strips the
        // entity), so we use a plain sparkle that renders for everyone. The keep-alive
        // timer re-sends it (drafts expire ~30s) and it shares the streaming draft_id, so
        // the response replaces it.
        await this.bot.api.raw.sendRichMessageDraft({
          chat_id: Number(chatId),
          draft_id: this.draftIdFor(chatId),
          rich_message: { html: '<tg-thinking>✨ Thinking…</tg-thinking>' },
        })
        return
      }
      await this.bot.api.sendChatAction(chatId, 'typing')
    } catch {
      // Non-critical; the keep-alive timer re-sends on the next tick.
    }
  }

  // ── User request cards ──────────────────────────────────────────────

  async sendUserRequestCard(chatId: string, event: UserRequestEvent): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected')

    if (isUnsupportedInChat(event)) {
      return this.sendRichOrHtml(chatId, `_${escapeMarkdown(describeUnsupportedRequest(event))}_`)
    }

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
          const header = q.header ? `**${escapeMarkdown(q.header)}**\n` : ''
          const text = `${header}${escapeMarkdown(q.question)}`

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

          lastMessageId = await this.sendRichOrHtml(
            chatId,
            text,
            keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : undefined,
          )
        }

        return lastMessageId
      }

      case 'secret_request': {
        const text = `**Secret requested:** ${codeSpan(event.secretName)}\n${event.reason ? `\nReason: ${escapeMarkdown(event.reason)}` : ''}\n\nPlease reply with the secret value.`
        return this.sendRichOrHtml(chatId, text)
      }

      case 'file_request': {
        const text = `**File requested:**\n${escapeMarkdown(event.description)}${event.fileTypes ? `\n\nAccepted types: ${escapeMarkdown(event.fileTypes)}` : ''}\n\nPlease upload the file.`
        return this.sendRichOrHtml(chatId, text)
      }

      case 'file_delivery': {
        // File transfer from container to chat is not yet supported — show metadata only
        const text = `**File delivered:** ${codeSpan(event.filePath)}${event.description ? `\n${escapeMarkdown(event.description)}` : ''}\n\n_File download not yet supported — view in the app._`
        return this.sendRichOrHtml(chatId, text)
      }

      case 'tool_status': {
        const emoji = event.status === 'success' ? '✅' : event.status === 'error' ? '❌' : event.status === 'cancelled' ? '⛔' : '⏳'
        return this.sendRichOrHtml(chatId, `🔧 **${escapeMarkdown(event.toolName)}** — ${escapeMarkdown(event.summary)} ${emoji}`)
      }

      default:
        return this.sendRichOrHtml(chatId, `_${escapeMarkdown(describeUnsupportedRequest(event))}_`)
    }
  }

  /** Handle an inline-keyboard button click: confirm the choice and emit the answer. */
  private async handleCallbackQuery(ctx: GrammyContext): Promise<void> {
    await ctx.answerCallbackQuery()
    const data = ctx.callbackQuery?.data
    if (!data) return
    const mapping = this.callbackDataMap.get(data)
    if (!mapping) return
    const val = mapping.value as { question: string; answer: string }

    // Update the message to show the selected answer and remove the keyboard.
    // Route through editRichOrHtml so the edit matches the connector's mode
    // (a rich edit in rich mode, HTML otherwise) instead of always HTML.
    const originalText = ctx.callbackQuery?.message?.text || ''
    const chatId = String(ctx.chat?.id ?? '')
    const messageId = String(ctx.callbackQuery?.message?.message_id ?? '')
    const confirmation = `${escapeMarkdown(originalText)}\n\n✅ **${escapeMarkdown(val.answer)}**`
    try {
      await this.editRichOrHtml(chatId, messageId, confirmation)
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
        }, chatId)
        this.pendingQuestions.delete(mapping.toolUseId)
      }
    } else {
      // Single question — emit immediately
      this.emitInteractiveResponse(mapping.toolUseId, mapping.value, chatId)
    }
  }

  // ── Dashboard cards ─────────────────────────────────────────────────

  async sendDashboardCard(
    chatId: string,
    opts: { integrationId: string; agentSlug: string; dashboardSlug: string; name: string; allowButton: boolean; emoji?: string; caption?: string },
  ): Promise<DashboardDelivery> {
    if (!this.bot) throw new Error('Bot not connected')
    // Render once; send through the same rich-markdown path as every other
    // outbound message (rich with an HTML fallback), so the card formats
    // consistently whether or not it carries the button.
    const card = renderDashboardCard(opts.name, opts.emoji, opts.caption)
    const base = getPlatformBaseUrl()
    // A working button needs both a public URL to point at and a caller that's
    // cleared to mint a Mini App cookie (allowButton). Without either, send the
    // formatted card as text rather than a button that would dead-end when tapped.
    if (!base || !opts.allowButton) {
      await this.sendRichOrHtml(chatId, card)
      if (!base) {
        console.warn('[telegram] dashboard sharing needs a public HTTPS base URL (web/server mode); sent plain text without the Open dashboard button')
      } else {
        console.warn('[telegram] dashboard integration has no owner to act as; sent plain text without the Open dashboard button')
      }
      return 'text'
    }
    const url = `${base.replace(/\/$/, '')}/api/telegram-miniapp?i=${encodeURIComponent(opts.integrationId)}&a=${encodeURIComponent(opts.agentSlug)}&d=${encodeURIComponent(opts.dashboardSlug)}`
    // Carry the contextual emoji onto the button so it ties to the card.
    const buttonLabel = `${resolveDashboardEmoji(opts.emoji)} Open dashboard`
    await this.sendRichOrHtml(chatId, card, {
      reply_markup: { inline_keyboard: [[{ text: buttonLabel, web_app: { url } }]] },
    })
    return 'button'
  }

  // ── First-poll batching ─────────────────────────────────────────────

  private handleTextMessage(ctx: GrammyContext): void {
    const text = ctx.message?.text
    if (!text || !ctx.chat) return

    const chatType = ctx.chat.type
    if (chatType === 'channel') return // out of scope v1; no chat row

    const chatId = String(ctx.chat.id)
    const fromId = String(ctx.from?.id || '')
    const messageId = String(ctx.message?.message_id || '')
    const userName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ')
      || ctx.from?.username
      || undefined
    // For groups use the chat title; for DMs use the user's name
    const chatName = ('title' in ctx.chat ? ctx.chat.title : undefined) || userName || undefined

    if (!this.hasCompletedFirstPoll) {
      // Buffer messages during first poll
      let pending = this.pendingFirstPollMessages.get(chatId)
      if (!pending) {
        pending = { texts: [], timer: null, userName, chatName, chatType }
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
      chatType: chatType,
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
      chatType: pending.chatType,
      userName: pending.userName,
      chatName: pending.chatName,
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

  private markdownToHtml(md: string): string {
    return markdownToTelegramHtml(md)
  }

  // ── Rich send helpers ───────────────────────────────────────────────

  /** Telegram private-chat ids are positive; groups/channels are negative. */
  private isPrivateChat(chatId: string): boolean {
    return Number(chatId) > 0
  }

  private get useRich(): boolean {
    return this.config.richMessages !== false
  }

  private richMessage(md: string): InputRichMessage {
    return markdownToRichMessage(md, { skipEntityDetection: this.config.skipEntityDetection === true })
  }

  /** Send a new rich message; on any rich-send failure, resend via legacy HTML. */
  private async sendRichOrHtml(
    chatId: string,
    md: string,
    other?: { reply_markup?: unknown; reply_parameters?: { message_id: number } },
  ): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected')
    if (this.useRich) {
      try {
        const sent = await this.bot.api.raw.sendRichMessage({
          chat_id: Number(chatId),
          rich_message: this.richMessage(md),
          ...(other as object),
        })
        return String(sent.message_id)
      } catch (err) {
        console.error('[TelegramConnector] rich send failed, falling back to HTML:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'rich-send-fallback' }, extra: { provider: 'telegram', chatId } })
      }
    }
    // The legacy HTML sink caps at 4096 chars, but `md` was chunked for the 32768
    // rich ceiling — re-split here so a long body (richMessages rollback or a
    // rich-send fallback) isn't rejected. Reply params ride only the first chunk.
    const htmlChunks = splitForHtmlLimits(md)
    let lastId = ''
    for (let i = 0; i < htmlChunks.length; i++) {
      const sent = await this.bot.api.sendMessage(chatId, this.markdownToHtml(htmlChunks[i]), {
        parse_mode: 'HTML',
        ...(i === 0 ? (other as object) : {}),
      })
      lastId = String(sent.message_id)
    }
    return lastId
  }

  /** Edit a message to rich; on any rich-edit failure, edit via legacy HTML. */
  private async editRichOrHtml(chatId: string, messageId: string, md: string): Promise<void> {
    if (!this.bot) return
    if (this.useRich) {
      try {
        await this.bot.api.raw.editMessageText({
          chat_id: Number(chatId),
          message_id: Number(messageId),
          rich_message: this.richMessage(md),
        })
        return
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (errMsg.includes('message is not modified')) return
        console.error('[TelegramConnector] rich edit failed, falling back to HTML:', err)
      }
    }
    try {
      await this.bot.api.editMessageText(chatId, Number(messageId), this.markdownToHtml(md), { parse_mode: 'HTML' })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (!errMsg.includes('message is not modified')) throw err
    }
  }

}
