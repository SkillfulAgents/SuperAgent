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
import type { SessionActivity } from '@shared/lib/types/agent'
import { ChatClientConnector, type OutgoingMessage } from './base-connector'
import { describeUnsupportedRequest, isUnsupportedInChat } from './utils'
import { captureException } from '@shared/lib/error-reporting'
import { markdownToRichMessage, splitForRichLimits, splitForHtmlLimits, escapeMarkdown, codeSpan } from './telegram-rich-message'
import type { InputRichMessage } from 'grammy/types'

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
  private pendingFirstPollMessages: Map<string, { texts: string[]; timer: ReturnType<typeof setTimeout> | null; userName?: string; chatName?: string; chatType?: 'private' | 'group' | 'supergroup' }> = new Map()

  // Track callback_query toolUseId mappings (Telegram callback_data is limited to 64 bytes)
  private callbackDataMap: Map<string, { toolUseId: string; value: unknown; ts: number }> = new Map()
  private nextCallbackId = 0
  private static readonly CALLBACK_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

  // Track pending multi-question requests: accumulate answers until all questions are answered
  private pendingQuestions: Map<string, {
    totalQuestions: number
    answers: Record<string, string> // { questionText: selectedAnswer }
    chatId: string
    // Single-select sub-cards of this multi-question card (multiSelect sub-cards live in
    // pendingMultiSelect); tracked so dismissOpenCards can strip every keyboard on cancel.
    cards: Array<{ messageId: string; cbIds: string[] }>
  }> = new Map()

  // Track open multiSelect questions: the redraw state + the accumulating checked set,
  // keyed by `${toolUseId} ${question}` (toolUseId has no spaces, so the join is unambiguous).
  // In-memory only — never encoded into callback_data, which Telegram caps at 64 bytes.
  private pendingMultiSelect: Map<string, {
    chatId: string
    messageId: string
    questionText: string
    options: Array<{ label: string; cbId: string }>
    doneCbId: string
    checked: Set<string>
  }> = new Map()

  // Track the open single-question AskUserQuestion card per chat, so a free-typed message can
  // be resolved as the "Other" answer. Set only for single-question cards (multi-question falls
  // through to cancel); cleared synchronously when the card is answered by any path.
  private openQuestionCard: Map<string, {
    toolUseId: string
    question: string
    questionText: string
    messageId: string
    multiSelect: boolean
    cbIds: string[]
  }> = new Map()

  // Animated DM draft streaming: per-chat non-zero draft id.
  private nextDraftId = 1
  private activeDrafts: Map<string, number> = new Map()
  // Latest activity per chat, so each render (driven by the manager's tick) shows
  // the current label even when it changes mid-turn (working → thinking → …).
  private workingActivity: Map<string, SessionActivity> = new Map()

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
    this.workingActivity.clear()

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

  async startWorking(chatId: string, activity: SessionActivity): Promise<void> {
    if (!this.bot) return
    // Render the labeled draft once. The manager's per-session tick re-calls this
    // for keep-alive (drafts expire ~30s), so the connector keeps no timer of its
    // own. Record the activity first so the render below shows the current label.
    this.workingActivity.set(chatId, activity)
    await this.sendWorkingIndicator(chatId)
  }

  async stopWorking(chatId: string): Promise<void> {
    this.workingActivity.delete(chatId)
    // The streaming response shares the draft_id and replaces the draft in place,
    // so the clear yields the surface — there is nothing else to tear down.
  }

  /** The native-draft label for a busy activity (`<tg-thinking>` inner HTML). */
  private workingLabel(activity: SessionActivity | undefined): string {
    switch (activity) {
      case 'compacting': return '🗜 Compacting…'
      case 'retrying': return '🔄 Retrying…'
      case 'thinking': return '✨ Thinking…'
      default: return '✨ Working…' // 'working' and any non-busy fallback
    }
  }

  /** Post the "working" indicator once: a native draft in rich DMs, else typing. */
  private async sendWorkingIndicator(chatId: string): Promise<void> {
    if (!this.bot) return
    try {
      if (this.useRich && this.config.draftStreaming !== false && this.isPrivateChat(chatId)) {
        // Native Telegram placeholder (RichBlockThinking / <tg-thinking>), labeled
        // by the agent's current activity. Draft-only, so DM-only. Static glyph:
        // the animated AIActions custom emoji only render when the bot's owner has
        // Telegram Premium (otherwise Telegram strips the entity), so we use plain
        // glyphs that render for everyone. The manager's tick re-sends it (drafts
        // expire ~30s) and it shares the streaming draft_id, so the response replaces it.
        const label = this.workingLabel(this.workingActivity.get(chatId))
        await this.bot.api.raw.sendRichMessageDraft({
          chat_id: Number(chatId),
          draft_id: this.draftIdFor(chatId),
          rich_message: { html: `<tg-thinking>${label}</tg-thinking>` },
        })
        return
      }
      await this.bot.api.sendChatAction(chatId, 'typing')
    } catch {
      // Non-critical; the manager's tick re-sends on the next tick.
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
            chatId,
            cards: [],
          })
        }

        // Send each question as its own message with its own keyboard
        for (const q of event.questions) {
          const header = q.header ? `**${escapeMarkdown(q.header)}**\n` : ''
          const text = `${header}${escapeMarkdown(q.question)}`
          const hasOptions = !!(q.options && q.options.length > 0)

          const singleQuestionCard = event.questions.length === 1

          if (hasOptions && q.multiSelect) {
            // Multi-select: each tap toggles a ✅; a Done button resolves the checked set.
            const options = q.options!.map((opt) => ({
              label: opt.label,
              cbId: this.registerCallback(event.toolUseId, { kind: 'multiToggle', question: q.question, label: opt.label }),
            }))
            const doneCbId = this.registerCallback(event.toolUseId, { kind: 'multiDone', question: q.question })
            const keyboard = options.map((o) => [{ text: o.label, callback_data: o.cbId }])
            keyboard.push([{ text: 'Done', callback_data: doneCbId }])
            lastMessageId = await this.sendRichOrHtml(chatId, text, { reply_markup: { inline_keyboard: keyboard } })
            this.pendingMultiSelect.set(this.multiSelectKey(event.toolUseId, q.question), {
              chatId, messageId: lastMessageId, questionText: text, options, doneCbId, checked: new Set(),
            })
            if (singleQuestionCard) {
              this.openQuestionCard.set(chatId, {
                toolUseId: event.toolUseId, question: q.question, questionText: text,
                messageId: lastMessageId, multiSelect: true, cbIds: [...options.map((o) => o.cbId), doneCbId],
              })
            }
            continue
          }

          const keyboard: Array<Array<{ text: string; callback_data: string }>> = []
          const cbIds: string[] = []
          if (hasOptions) {
            for (const opt of q.options!) {
              // Single-select: store the full answer payload { question, answer }; first tap resolves.
              const cbId = this.registerCallback(event.toolUseId, {
                question: q.question,
                answer: opt.label,
              })
              cbIds.push(cbId)
              keyboard.push([{ text: opt.label, callback_data: cbId }])
            }
          }

          lastMessageId = await this.sendRichOrHtml(
            chatId,
            text,
            keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : undefined,
          )
          if (singleQuestionCard) {
            this.openQuestionCard.set(chatId, {
              toolUseId: event.toolUseId, question: q.question, questionText: text,
              messageId: lastMessageId, multiSelect: false, cbIds,
            })
          } else if (hasOptions) {
            // Multi-question single-select sub-card: track its message + callbacks so a cancel can
            // strip the keyboard (multiSelect sub-cards are tracked in pendingMultiSelect instead).
            this.pendingQuestions.get(event.toolUseId)?.cards.push({ messageId: lastMessageId, cbIds })
          }
        }

        return lastMessageId
      }

      // secret_request / file_request are handled by the isUnsupportedInChat early-return above
      // (desktop-only fallback); they intentionally have no prompt case here.

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

  private multiSelectKey(toolUseId: string, question: string): string {
    return `${toolUseId} ${question}`
  }

  /** Handle an inline-keyboard button click. Single-select resolves on tap; multi-select toggles
   *  and only resolves on Done. The callback is answered inside each branch so the empty-Done
   *  toast can fire (a callback can be answered exactly once). */
  private async handleCallbackQuery(ctx: GrammyContext): Promise<void> {
    const data = ctx.callbackQuery?.data
    if (!data) { await ctx.answerCallbackQuery(); return }
    const mapping = this.callbackDataMap.get(data)
    if (!mapping) { await ctx.answerCallbackQuery(); return }
    const val = mapping.value as { kind?: 'multiToggle' | 'multiDone'; question: string; answer?: string; label?: string }

    if (val.kind === 'multiToggle') { await this.handleMultiSelectToggle(ctx, mapping.toolUseId, val.question, val.label ?? ''); return }
    if (val.kind === 'multiDone') { await this.handleMultiSelectDone(ctx, mapping.toolUseId, val.question); return }

    // Single-select: confirm the choice, strip the keyboard, and emit the answer. Claim the card
    // synchronously (before the first await) so a racing typed "Other" answer can't also resolve it.
    // Delete the WHOLE card's callbacks, not just the tapped one, so a fast tap on a sibling option
    // can't double-resolve (matching answerOpenQuestionWithText / handleMultiSelectDone).
    const chatId = String(ctx.chat?.id ?? '')
    const messageId = String(ctx.callbackQuery?.message?.message_id ?? '')
    const card = this.openQuestionCard.get(chatId)
    const cardCbIds =
      card && card.toolUseId === mapping.toolUseId
        ? card.cbIds
        : this.pendingQuestions.get(mapping.toolUseId)?.cards.find((c) => c.messageId === messageId)?.cbIds
    for (const cb of cardCbIds ?? [data]) this.callbackDataMap.delete(cb)
    this.callbackDataMap.delete(data)
    this.openQuestionCard.delete(chatId)

    await ctx.answerCallbackQuery()
    const originalText = ctx.callbackQuery?.message?.text || ''
    const confirmation = `${escapeMarkdown(originalText)}\n\n✅ **${escapeMarkdown(val.answer ?? '')}**`
    try {
      await this.editRichOrHtml(chatId, messageId, confirmation)
    } catch {
      try { await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }) } catch { /* ignore */ }
    }
    this.emitAnswer(mapping.toolUseId, val.question, val.answer ?? '', chatId)
  }

  /** Toggle a multiSelect option's ✅ and redraw the keyboard; does not resolve. */
  private async handleMultiSelectToggle(ctx: GrammyContext, toolUseId: string, question: string, label: string): Promise<void> {
    const state = this.pendingMultiSelect.get(this.multiSelectKey(toolUseId, question))
    if (!state) { await ctx.answerCallbackQuery(); return }
    if (state.checked.has(label)) state.checked.delete(label)
    else state.checked.add(label)

    const keyboard = state.options.map((o) => [{
      text: state.checked.has(o.label) ? `✅ ${o.label}` : o.label,
      callback_data: o.cbId,
    }])
    keyboard.push([{ text: 'Done', callback_data: state.doneCbId }])
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: keyboard } })
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      if (!m.includes('message is not modified')) console.error('[TelegramConnector] multi-select redraw failed:', err)
    }
    await ctx.answerCallbackQuery()
  }

  /** Resolve a multiSelect question with the checked options, joined by ", ". */
  private async handleMultiSelectDone(ctx: GrammyContext, toolUseId: string, question: string): Promise<void> {
    const state = this.pendingMultiSelect.get(this.multiSelectKey(toolUseId, question))
    if (!state) { await ctx.answerCallbackQuery(); return }
    if (state.checked.size === 0) {
      await ctx.answerCallbackQuery({ text: 'Select at least one option, then tap Done.' })
      return
    }
    const answer = [...state.checked].join(', ')

    // Claim the card synchronously (before any await) so a racing typed "Other" answer or a
    // second Done tap can't also resolve it.
    for (const o of state.options) this.callbackDataMap.delete(o.cbId)
    this.callbackDataMap.delete(state.doneCbId)
    this.pendingMultiSelect.delete(this.multiSelectKey(toolUseId, question))
    this.openQuestionCard.delete(state.chatId)

    await ctx.answerCallbackQuery()

    // Build the confirmation from the stored question text — rich messages carry no `.text`.
    const confirmation = `${state.questionText}\n\n✅ **${escapeMarkdown(answer)}**`
    try {
      await this.editRichOrHtml(state.chatId, state.messageId, confirmation)
    } catch { /* ignore */ }
    try { await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }) } catch { /* ignore */ }

    this.emitAnswer(toolUseId, question, answer, state.chatId)
  }

  /**
   * Resolve an open single-question card with free-typed text as the "Other" answer (the text
   * overrides any checked boxes, mirroring the app). Returns true only if a live card matching
   * `toolUseId` is open for this chat — so the manager consumes the message only on a real resolve
   * and otherwise sends it as a fresh turn.
   */
  async answerOpenQuestionWithText(chatId: string, toolUseId: string, text: string): Promise<boolean> {
    const card = this.openQuestionCard.get(chatId)
    if (!card || card.toolUseId !== toolUseId) return false

    this.openQuestionCard.delete(chatId)
    if (card.multiSelect) this.pendingMultiSelect.delete(this.multiSelectKey(card.toolUseId, card.question))
    for (const cb of card.cbIds) this.callbackDataMap.delete(cb)

    // Confirm + strip the keyboard. Build the confirmation from the stored question text, since
    // rich messages carry no readable `.text`.
    const confirmation = `${card.questionText}\n\n✅ **${escapeMarkdown(text)}**`
    try {
      await this.editRichOrHtml(chatId, card.messageId, confirmation)
    } catch { /* best-effort */ }
    try {
      await this.bot?.api.editMessageReplyMarkup(Number(chatId), Number(card.messageId), { reply_markup: { inline_keyboard: [] } })
    } catch { /* best-effort */ }

    this.emitAnswer(card.toolUseId, card.question, text, chatId)
    return true
  }

  /**
   * Strip and clear every open question card for this chat: remove its inline keyboard and forget
   * its callbacks, so a card abandoned by a cancelling message doesn't keep showing live buttons
   * (a later tap would otherwise resolve an already-rejected request). Best-effort: edit failures
   * are swallowed (the card may already have been edited/answered).
   */
  async dismissOpenCards(chatId: string): Promise<void> {
    const messageIds = new Set<string>()

    const single = this.openQuestionCard.get(chatId)
    if (single) {
      messageIds.add(single.messageId)
      for (const cb of single.cbIds) this.callbackDataMap.delete(cb)
      this.openQuestionCard.delete(chatId)
    }

    for (const [key, state] of this.pendingMultiSelect) {
      if (state.chatId !== chatId) continue
      messageIds.add(state.messageId)
      for (const o of state.options) this.callbackDataMap.delete(o.cbId)
      this.callbackDataMap.delete(state.doneCbId)
      this.pendingMultiSelect.delete(key)
    }

    for (const [toolUseId, pending] of this.pendingQuestions) {
      if (pending.chatId !== chatId) continue
      for (const card of pending.cards) {
        messageIds.add(card.messageId)
        for (const cb of card.cbIds) this.callbackDataMap.delete(cb)
      }
      this.pendingQuestions.delete(toolUseId)
    }

    for (const messageId of messageIds) {
      try {
        await this.bot?.api.editMessageReplyMarkup(Number(chatId), Number(messageId), { reply_markup: { inline_keyboard: [] } })
      } catch { /* best-effort */ }
    }
  }

  /** Emit one question's answer, accumulating across a multi-question card before resolving. */
  private emitAnswer(toolUseId: string, question: string, answer: string, chatId: string): void {
    const pending = this.pendingQuestions.get(toolUseId)
    if (pending) {
      pending.answers[question] = answer
      if (Object.keys(pending.answers).length >= pending.totalQuestions) {
        this.emitInteractiveResponse(toolUseId, { question: '_all', answer: '_all', answers: pending.answers }, chatId)
        this.pendingQuestions.delete(toolUseId)
      }
    } else {
      this.emitInteractiveResponse(toolUseId, { question, answer }, chatId)
    }
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
