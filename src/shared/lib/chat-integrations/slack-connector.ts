/**
 * SlackConnector — Slack Bot integration via @slack/bolt Socket Mode.
 *
 * Uses WebSocket (Socket Mode) for Electron compatibility — no webhooks.
 * Supports streaming via chat.update with throttling.
 * User request cards rendered as Block Kit components.
 * Typing indicator via emoji reactions (Slack doesn't support bot typing).
 */

import { App as SlackApp } from '@slack/bolt'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import { ChatClientConnector, type OutgoingMessage } from './base-connector'
import { captureException } from '@shared/lib/error-reporting'

// ── Config ──────────────────────────────────────────────────────────────

export interface SlackConfig {
  botToken: string
  appToken: string
  channelId?: string
}

// ── Slack limits ────────────────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 3000 // Slack's mrkdwn rendering gets unreliable past ~4000; be conservative

// ── Markdown → Slack mrkdwn ─────────────────────────────────────────────

/**
 * Convert standard Markdown to Slack mrkdwn format.
 * Slack uses its own subset: *bold*, _italic_, ~strikethrough~, `code`, ```code blocks```.
 * Links: <url|label>. No nested formatting.
 */
export function markdownToSlackMrkdwn(md: string): string {
  if (!md) return ''

  let result = md

  // Fenced code blocks → Slack triple backticks (must be done BEFORE inline transforms)
  result = result.replace(/```[\w]*\n([\s\S]*?)```/g, '```$1```')

  // Headings → bold text (use placeholder to avoid italic re-matching)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '\x01BOLD_START\x01$1\x01BOLD_END\x01')

  // Italic first (single * or _): *text* → _text_ (must happen BEFORE bold conversion)
  // Only match single *, not **
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_')

  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*')
  result = result.replace(/__(.+?)__/g, '*$1*')

  // Restore heading bold markers
  result = result.replace(/\x01BOLD_START\x01/g, '*')
  result = result.replace(/\x01BOLD_END\x01/g, '*')

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~')

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')

  // Unordered lists: - item or * item → • item (keep it simple)
  result = result.replace(/^[\t ]*[-*]\s+/gm, '• ')

  // Horizontal rules → line separator
  result = result.replace(/^---+$/gm, '───────────────────')

  // Blockquotes: > text → > text (Slack supports this natively)
  // Already compatible, no change needed

  // Tables: convert to monospace pre block
  result = result.replace(
    /(?:^[|].*[|]$\n?)+/gm,
    (match) => {
      const lines = match.trim().split('\n')
      // Filter out separator rows (|---|---|)
      const dataLines = lines.filter(line => !line.match(/^\|[\s-:|]+\|$/))
      const rows = dataLines.map(line =>
        line.split('|').filter(Boolean).map(cell => cell.trim())
      )
      if (rows.length === 0) return match

      // Calculate column widths
      const colCount = Math.max(...rows.map(r => r.length))
      const colWidths = Array.from({ length: colCount }, (_, col) =>
        Math.max(...rows.map(r => (r[col] || '').length))
      )
      const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length))
      const formatRow = (row: string[]) =>
        row.map((cell, i) => pad(cell, colWidths[i] || 0)).join('  ')

      let out = '```\n'
      if (rows.length > 0) {
        out += formatRow(rows[0]) + '\n'
        out += colWidths.map(w => '-'.repeat(w)).join('  ') + '\n'
        for (let i = 1; i < rows.length; i++) {
          out += formatRow(rows[i]) + '\n'
        }
      }
      out += '```'
      return out
    },
  )

  // Clean up excessive newlines
  result = result.replace(/\n{3,}/g, '\n\n')

  return result.trim()
}

// ── Connector ───────────────────────────────────────────────────────────

export class SlackConnector extends ChatClientConnector {
  readonly provider = 'slack' as const

  private app: SlackApp | null = null
  private connected = false
  private botUserId: string | null = null

  // Track action_id → toolUseId mappings for interactive responses
  private actionDataMap: Map<string, { toolUseId: string; value: unknown; ts: number }> = new Map()
  private nextActionId = 0
  private static readonly ACTION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

  // Track pending multi-question requests
  private pendingQuestions: Map<string, {
    totalQuestions: number
    answers: Record<string, string>
  }> = new Map()

  // Track last user message ts per channel for reaction-based typing indicator
  private lastUserMessageTs: Map<string, string> = new Map()

  // Track whether we have a thinking reaction active
  private activeReactions: Set<string> = new Set() // channelId:ts

  constructor(private config: SlackConfig) {
    super()
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.app = new SlackApp({
      token: this.config.botToken,
      appToken: this.config.appToken,
      socketMode: true,
      logLevel: 'warn' as any,
    })

    // Catch-all for events we don't explicitly handle (Bolt requires ack for all events)
    this.app.event(/.*/, async ({ event }) => {
      // No-op — just acknowledge so Slack doesn't retry/disconnect
    })

    // Handle incoming messages
    this.app.message(async ({ message, say }) => {
      // Skip bot messages, edits, etc.
      // Skip bot messages, edits, etc. — but allow file_share (user sent an image/file)
      const subtype = (message as any).subtype
      if (!message || (subtype && subtype !== 'file_share')) return
      const msg = message as any

      const text = msg.text || ''
      const chatId = msg.channel || ''
      const userId = msg.user || ''
      const ts = msg.ts || ''

      // Track message ts for reaction-based typing
      this.lastUserMessageTs.set(chatId, ts)

      // Resolve real user and channel names
      const userName = await this.resolveUserName(userId)
      const chatName = await this.resolveChannelName(chatId)

      // Handle file uploads
      const files = msg.files?.map((f: any) => ({
        name: f.name || 'file',
        url: f.url_private_download || f.url_private || f.permalink || '',
        mimeType: f.mimetype,
      }))

      this.emitMessage({
        externalMessageId: ts,
        text,
        chatId,
        userId,
        userName,
        chatName,
        files: files?.length ? files : undefined,
        timestamp: new Date(Number(ts) * 1000),
      })
    })

    // Handle button clicks (interactive actions)
    this.app.action(/^cb_\d+$/, async ({ ack, action, body }) => {
      await ack()

      const actionId = (action as any).action_id
      const mapping = this.actionDataMap.get(actionId)
      if (!mapping) return

      const val = mapping.value as { question: string; answer: string }

      // Update the message to show the selected answer
      try {
        const channel = (body as any).channel?.id
        const messageTs = (body as any).message?.ts
        if (channel && messageTs) {
          const originalText = (body as any).message?.text || ''
          // Preserve non-action blocks, only remove the buttons
          const existingBlocks = ((body as any).message?.blocks || []) as Array<{ type: string }>
          const preserved = existingBlocks.filter((b) => b.type !== 'actions')
          await this.app!.client.chat.update({
            channel,
            ts: messageTs,
            text: `${originalText}\n\n:white_check_mark: *${val.answer}*`,
            blocks: preserved,
          })
        }
      } catch {
        // Non-critical — message may have been deleted
      }

      this.actionDataMap.delete(actionId)

      // Accumulate answer for multi-question requests
      const pending = this.pendingQuestions.get(mapping.toolUseId)
      if (pending) {
        pending.answers[val.question] = val.answer
        if (Object.keys(pending.answers).length >= pending.totalQuestions) {
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
    })

    // Validate tokens before starting Socket Mode
    try {
      const authResult = await this.app.client.auth.test()
      if (!authResult.ok) {
        throw new Error(`Slack auth.test failed: ${authResult.error}`)
      }
      this.botUserId = authResult.user_id || null
      console.log(`[SlackConnector] Authenticated as ${authResult.user} in workspace ${authResult.team}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Slack bot token invalid: ${msg}`)
    }

    // Start Socket Mode (requires valid app-level token with connections:write)
    try {
      await this.app.start()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Slack Socket Mode failed to start (check app-level token and connections:write scope): ${msg}`)
    }
    this.connected = true
    console.log('[SlackConnector] Socket Mode connected')
  }

  async disconnect(): Promise<void> {
    this.connected = false

    // Remove any active reactions
    for (const key of this.activeReactions) {
      const [channel, ts] = key.split(':')
      this.removeThinkingReaction(channel, ts).catch(() => {})
    }
    this.activeReactions.clear()
    this.actionDataMap.clear()
    this.pendingQuestions.clear()
    this.lastUserMessageTs.clear()
    this.userNameCache.clear()
    this.channelNameCache.clear()

    if (this.app) {
      await this.app.stop()
      this.app = null
    }
    console.log('[SlackConnector] Disconnected')
  }

  isConnected(): boolean {
    return this.connected
  }

  // ── Message sending ─────────────────────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<string> {
    if (!this.app) throw new Error('Slack app not connected')

    const mrkdwn = markdownToSlackMrkdwn(message.text || '(empty message)')
    const chunks = this.splitMessage(mrkdwn)

    let lastTs = ''
    for (const chunk of chunks) {
      const result = await this.app.client.chat.postMessage({
        channel: chatId,
        text: chunk,
        mrkdwn: true,
      })
      lastTs = result.ts || ''
    }

    // Remove thinking reaction now that we've sent a real message
    await this.clearThinkingReaction(chatId)

    return lastTs
  }

  async sendFile(chatId: string, fileData: Buffer, filename: string, caption?: string): Promise<string> {
    if (!this.app) throw new Error('Slack app not connected')

    const result = await this.app.client.filesUploadV2({
      channel_id: chatId,
      file: fileData,
      filename,
      initial_comment: caption,
    })

    // filesUploadV2 returns files array; extract the message ts if available
    const file = (result as any).files?.[0]
    return file?.shares?.public?.[chatId]?.[0]?.ts || file?.shares?.private?.[chatId]?.[0]?.ts || ''
  }

  async sendStreamingUpdate(chatId: string, text: string, existingMessageId?: string): Promise<string> {
    if (!this.app) throw new Error('Slack app not connected')

    const truncated = text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH - 20) + '\n\n... (truncated)'
      : text
    const displayText = markdownToSlackMrkdwn(truncated || ':hourglass_flowing_sand: Thinking...')

    if (!existingMessageId) {
      const result = await this.app.client.chat.postMessage({
        channel: chatId,
        text: displayText,
        mrkdwn: true,
      })
      return result.ts || ''
    }

    // Edit existing message
    try {
      await this.app.client.chat.update({
        channel: chatId,
        ts: existingMessageId,
        text: displayText,
      })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      // Slack returns this when text hasn't changed
      if (!errMsg.includes('no_change') && !errMsg.includes('message_not_found')) {
        throw err
      }
    }
    return existingMessageId
  }

  async finalizeStreamingMessage(chatId: string, messageId: string, finalText: string): Promise<void> {
    if (!this.app) return

    const truncated = finalText.length > MAX_MESSAGE_LENGTH
      ? finalText.slice(0, MAX_MESSAGE_LENGTH - 20) + '\n\n... (truncated)'
      : finalText

    try {
      await this.app.client.chat.update({
        channel: chatId,
        ts: messageId,
        text: markdownToSlackMrkdwn(truncated || '(empty response)'),
      })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (!errMsg.includes('no_change')) {
        console.error('[SlackConnector] Failed to finalize message:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'finalize-message' }, extra: { provider: 'slack', chatId, messageId } })
      }
    }

    // Remove thinking reaction
    await this.clearThinkingReaction(chatId)
  }

  async showTypingIndicator(chatId: string): Promise<void> {
    if (!this.app) return

    // Slack doesn't support typing indicators for bots.
    // Workaround: add a :thinking_face: reaction to the user's last message.
    const lastTs = this.lastUserMessageTs.get(chatId)
    if (!lastTs) return

    const key = `${chatId}:${lastTs}`
    if (this.activeReactions.has(key)) return // Already reacting

    try {
      await this.app.client.reactions.add({
        channel: chatId,
        timestamp: lastTs,
        name: 'thinking_face',
      })
      this.activeReactions.add(key)
    } catch {
      // Already reacted or message deleted — non-critical
    }
  }

  // ── User request cards ──────────────────────────────────────────────

  async sendUserRequestCard(chatId: string, event: UserRequestEvent): Promise<string> {
    if (!this.app) throw new Error('Slack app not connected')

    switch (event.type) {
      case 'user_question_request': {
        let lastTs = ''

        // Track multi-question requests
        if (event.questions.length > 1) {
          this.pendingQuestions.set(event.toolUseId, {
            totalQuestions: event.questions.length,
            answers: {},
          })
        }

        // Send each question as its own message with buttons
        for (const q of event.questions) {
          const blocks: any[] = []

          if (q.header) {
            blocks.push({
              type: 'section',
              text: { type: 'mrkdwn', text: `*${q.header}*` },
            })
          }

          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: q.question },
          })

          if (q.options && q.options.length > 0) {
            const buttons = q.options.map(opt => {
              const actionId = this.registerAction(event.toolUseId, {
                question: q.question,
                answer: opt.label,
              })
              return {
                type: 'button' as const,
                text: { type: 'plain_text' as const, text: opt.label },
                action_id: actionId,
              }
            })
            blocks.push({
              type: 'actions',
              elements: buttons,
            })
          }

          const result = await this.app.client.chat.postMessage({
            channel: chatId,
            text: q.question, // Fallback text
            blocks,
          })
          lastTs = result.ts || ''
        }

        return lastTs
      }

      case 'secret_request': {
        const result = await this.app.client.chat.postMessage({
          channel: chatId,
          text: `*Secret requested:* \`${event.secretName}\`${event.reason ? `\nReason: ${event.reason}` : ''}\n\nPlease reply with the secret value.`,
          mrkdwn: true,
        })
        return result.ts || ''
      }

      case 'file_request': {
        const result = await this.app.client.chat.postMessage({
          channel: chatId,
          text: `*File requested:*\n${event.description}${event.fileTypes ? `\n\nAccepted types: ${event.fileTypes}` : ''}\n\nPlease upload the file.`,
          mrkdwn: true,
        })
        return result.ts || ''
      }

      case 'file_delivery': {
        // File transfer from container to chat is not yet supported — show metadata only
        const result = await this.app.client.chat.postMessage({
          channel: chatId,
          text: `*File delivered:* \`${event.filePath}\`${event.description ? `\n${event.description}` : ''}\n\n_File download not yet supported — view in the app._`,
          mrkdwn: true,
        })
        return result.ts || ''
      }

      case 'tool_status': {
        const emoji = event.status === 'success' ? ':white_check_mark:'
          : event.status === 'error' ? ':x:'
          : event.status === 'cancelled' ? ':no_entry_sign:'
          : ':hourglass_flowing_sand:'
        const result = await this.app.client.chat.postMessage({
          channel: chatId,
          text: `:wrench: *${event.toolName}* — \`${event.summary}\` ${emoji}`,
          mrkdwn: true,
        })
        return result.ts || ''
      }

      default: {
        // Generic card for other event types
        const result = await this.app.client.chat.postMessage({
          channel: chatId,
          text: `*${event.type}*\n\`\`\`${JSON.stringify(event, null, 2).slice(0, 2500)}\`\`\``,
          mrkdwn: true,
        })
        return result.ts || ''
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private registerAction(toolUseId: string, value: unknown): string {
    // Evict stale action entries to prevent unbounded growth
    const now = Date.now()
    for (const [key, entry] of this.actionDataMap) {
      if (now - entry.ts > SlackConnector.ACTION_TTL_MS) {
        this.actionDataMap.delete(key)
      }
    }
    const id = `cb_${this.nextActionId++}`
    this.actionDataMap.set(id, { toolUseId, value, ts: now })
    return id
  }

  private async clearThinkingReaction(chatId: string): Promise<void> {
    const lastTs = this.lastUserMessageTs.get(chatId)
    if (!lastTs) return

    const key = `${chatId}:${lastTs}`
    if (this.activeReactions.has(key)) {
      await this.removeThinkingReaction(chatId, lastTs)
      this.activeReactions.delete(key)
    }
  }

  private async removeThinkingReaction(channel: string, ts: string): Promise<void> {
    if (!this.app) return
    try {
      await this.app.client.reactions.remove({
        channel,
        timestamp: ts,
        name: 'thinking_face',
      })
    } catch {
      // Reaction already removed or message deleted — non-critical
    }
  }

  // Cache resolved names with TTL to prevent unbounded growth
  private userNameCache: Map<string, { value: string; ts: number }> = new Map()
  private channelNameCache: Map<string, { value: string; ts: number }> = new Map()
  private static readonly CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!this.app || !userId) return undefined
    const cached = this.userNameCache.get(userId)
    if (cached && Date.now() - cached.ts < SlackConnector.CACHE_TTL_MS) return cached.value
    try {
      const result = await this.app.client.users.info({ user: userId })
      const name = result.user?.real_name || result.user?.name || undefined
      if (name) this.userNameCache.set(userId, { value: name, ts: Date.now() })
      return name
    } catch (err) {
      console.warn(`[SlackConnector] Failed to resolve user name for ${userId}:`, err instanceof Error ? err.message : err)
      return undefined
    }
  }

  private async resolveChannelName(channelId: string): Promise<string | undefined> {
    if (!this.app || !channelId) return undefined
    const cached = this.channelNameCache.get(channelId)
    if (cached && Date.now() - cached.ts < SlackConnector.CACHE_TTL_MS) return cached.value
    try {
      const result = await this.app.client.conversations.info({ channel: channelId })
      // For channels/groups use the channel name; for DMs return undefined
      // so that the resolved userName (from users.info) is used instead.
      const channel = result.channel as any
      const name = channel?.is_im ? undefined : (channel?.name || undefined)
      if (name) this.channelNameCache.set(channelId, { value: name, ts: Date.now() })
      return name
    } catch {
      return undefined
    }
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
