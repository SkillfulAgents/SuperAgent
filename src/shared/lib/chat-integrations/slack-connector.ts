/**
 * SlackConnector — Slack Bot integration via @slack/bolt Socket Mode.
 *
 * Uses WebSocket (Socket Mode) for Electron compatibility — no webhooks.
 * Supports streaming via chat.update with throttling.
 * User request cards rendered as Block Kit components.
 * Typing indicator via emoji reactions (Slack doesn't support bot typing).
 */

import { App as SlackApp, SocketModeReceiver } from '@slack/bolt'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import type { SessionActivity } from '@shared/lib/types/agent'
import {
  ChatClientConnector,
  type ChatConversationType,
  type ChatDirectoryChannel,
  type ChatDirectoryPage,
  type ChatDirectoryUser,
  type OutgoingMessage,
  type SystemPromptContext,
} from './base-connector'
import { describeUnsupportedRequest, isUnsupportedInChat, splitChatMessage } from './utils'
import { isUnrecoverableSlackError } from './slack-error'
import { captureException } from '@shared/lib/error-reporting'

// ── Config ──────────────────────────────────────────────────────────────

export interface SlackConfig {
  botToken: string
  appToken: string
  channelId?: string
  onlyMentioned?: boolean
  answerInThread?: boolean
  newSessionPerThread?: boolean
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
  const BOLD_START = '%%BOLD_S%%'
  const BOLD_END = '%%BOLD_E%%'
  result = result.replace(/^#{1,6}\s+(.+)$/gm, `${BOLD_START}$1${BOLD_END}`)

  // Italic first (single * or _): *text* → _text_ (must happen BEFORE bold conversion)
  // Only match single *, not **
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_')

  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*')
  result = result.replace(/__(.+?)__/g, '*$1*')

  // Restore heading bold markers
  result = result.replace(new RegExp(BOLD_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '*')
  result = result.replace(new RegExp(BOLD_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '*')

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

// ── Session system prompt ───────────────────────────────────────────────

/**
 * Session-level context for Slack conversations, built per session so it names
 * the concrete destination (DM vs channel vs thread). Without this the agent
 * cannot tell where its replies land or that its transcript streams straight
 * into the chat — it has misrouted messages by replying through
 * send_chat_message and guessing a DM target.
 */
export function buildSlackSystemPrompt(message: SystemPromptContext): string {
  const pipeIdx = message.chatId.indexOf('|')
  const isThread = pipeIdx > 0
  const baseChannelId = isThread ? message.chatId.slice(0, pipeIdx) : message.chatId
  // Classify by conversation-id prefix (D* = DM, C*/G* = channel/group), NOT
  // by whether chatName resolved: resolveChannelName returns undefined when
  // conversations.info fails, and misclassifying a channel as a DM would drop
  // the multi-user attribution guidance below.
  const isDm = baseChannelId.startsWith('D')
  const where = isThread
    ? `a message thread in ${message.chatName || `channel ${baseChannelId}`}`
    : isDm
      ? `a direct message conversation with ${message.userName || 'a Slack user'}`
      : message.chatName
        ? `the channel ${message.chatName}`
        : `a channel (id ${baseChannelId})`
  const isGroupContext = !isDm
  return `This session is a live Slack conversation: you are responding inside ${where} (chat id: ${message.chatId}). Follow these rules:
- Everything you write is posted to this conversation as the bot. Your response text IS the Slack message participants read, delivered automatically — including interim text between tool calls. There is no private narration; write only what participants should see.
- Never use send_chat_message to reply to this conversation — your reply is already delivered automatically, so that would post it twice. Only use send_chat_message to reach a DIFFERENT chat (for example, to DM a specific person or post to another channel).${isGroupContext ? `
- Multiple people can take part. Incoming messages are prefixed with the sender's name (for example "[Jane Doe]: ..."); the prefix is added for attribution — the sender did not type it. Keep track of who is asking for what.` : ''}
- Keep responses concise and conversational — this is a chat, not a document.`
}

// ── Chat id classification ──────────────────────────────────────────────

/**
 * Classify a Slack (effective) chat id by shape: `channel|threadTs` composites
 * are threads, and top-level conversation ids encode their type in the prefix
 * (D* = DM, G* = private group/mpim, C* = channel).
 */
export function classifySlackChatId(chatId: string): ChatConversationType | undefined {
  if (chatId.indexOf('|') > 0) return 'thread'
  if (chatId.startsWith('D')) return 'dm'
  if (chatId.startsWith('G')) return 'group'
  if (chatId.startsWith('C')) return 'channel'
  return undefined
}

// ── Message routing (exported for testing) ──────────────────────────────

export interface SlackMessageRoutingParams {
  rawText: string
  chatId: string
  ts: string
  channelType: string
  threadTs?: string
  botUserId: string | null
  config: Pick<SlackConfig, 'onlyMentioned' | 'answerInThread' | 'newSessionPerThread'>
  activeThreads: ReadonlySet<string>
}

export interface SlackMessageRoutingResult {
  shouldProcess: boolean
  effectiveChatId: string
  threadContext?: { channel: string; threadTs: string }
  threadKey?: string
  /**
   * True when this message is the bot's first appearance in an already-existing
   * thread (the thread isn't in `activeThreads` yet). The caller should backfill
   * earlier thread messages as context. Computed against `activeThreads` as
   * passed in — i.e. before the caller marks this thread active.
   */
  isNewThreadEntry: boolean
}

export function routeSlackMessage(params: SlackMessageRoutingParams): SlackMessageRoutingResult {
  const { rawText, chatId, ts, channelType, threadTs, botUserId, config, activeThreads } = params
  const isChannel = channelType === 'channel' || channelType === 'group'

  if (isChannel && config.onlyMentioned) {
    const isMentioned = botUserId ? rawText.includes(`<@${botUserId}>`) : false
    if (!isMentioned) {
      if (!threadTs || !activeThreads.has(`${chatId}|${threadTs}`)) {
        return { shouldProcess: false, effectiveChatId: chatId, isNewThreadEntry: false }
      }
    }
  }

  let effectiveChatId = chatId
  let threadContext: { channel: string; threadTs: string } | undefined
  let threadKey: string | undefined

  // Reply inside a thread when either:
  // - answerInThread is on (thread every channel message), or
  // - the inbound message is itself already inside a thread — continue that
  //   thread instead of dropping the reply into the main channel, even when
  //   answerInThread is off (SUP-282).
  const inExistingThread = !!threadTs
  if (isChannel && (config.answerInThread || inExistingThread)) {
    const threadAnchor = threadTs || ts
    // Give the thread its own session (composite chatId) when newSessionPerThread
    // is on, OR when answerInThread is off but the message is inside a thread.
    // In the latter case the channel otherwise shares a single session across all
    // threads, so the reply destination would live only in the mutable
    // threadContextMap — which a concurrent message can overwrite before the reply
    // streams back (replies arrive async on a separate SSE queue). Encoding the
    // anchor in effectiveChatId makes the destination travel immutably with the
    // session: resolveSlackChannel recovers it by parsing the composite id, so
    // routing never depends on shared state a later message could clobber (SUP-282).
    if (config.newSessionPerThread || (!config.answerInThread && inExistingThread)) {
      effectiveChatId = `${chatId}|${threadAnchor}`
    }
    threadContext = { channel: chatId, threadTs: threadAnchor }
    threadKey = `${chatId}|${threadAnchor}`
  }

  // Joining an existing thread for the first time: backfill its history. Only
  // when the message is itself in a thread (threadTs) and we haven't tracked
  // that thread yet — a brand-new top-level message has no history to fetch.
  const isNewThreadEntry = !!(threadKey && threadTs && !activeThreads.has(threadKey))

  return { shouldProcess: true, effectiveChatId, threadContext, threadKey, isNewThreadEntry }
}

export function resolveSlackChannel(
  effectiveChatId: string,
  threadContextMap: ReadonlyMap<string, { channel: string; threadTs: string }>,
): { channel: string; threadTs?: string } {
  const ctx = threadContextMap.get(effectiveChatId)
  if (ctx) return ctx

  const pipeIdx = effectiveChatId.indexOf('|')
  if (pipeIdx > 0) {
    return {
      channel: effectiveChatId.slice(0, pipeIdx),
      threadTs: effectiveChatId.slice(pipeIdx + 1),
    }
  }

  return { channel: effectiveChatId }
}

/**
 * Insert `key` at the most-recently-used position of an insertion-ordered Set,
 * evicting the oldest entries once size exceeds `max`. Keeps long-lived tracking
 * sets bounded so a connector that touches more and more threads over a
 * long-running process can't leak memory. Re-inserting an existing key refreshes
 * its recency (delete + re-add).
 */
export function touchAndCapSet(set: Set<string>, key: string, max: number): void {
  set.delete(key)
  set.add(key)
  while (set.size > max) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

/** Map counterpart of {@link touchAndCapSet}: (re)inserts `key` as MRU and evicts the oldest beyond `max`. */
export function touchAndCapMap<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/**
 * Every tracked thinking-reaction for a chat. Reaction keys are `${chatId}:${ts}`;
 * the colon-delimited prefix avoids matching a chat whose id is a prefix of another.
 * Used to sweep ALL reactions on clear so a mid-turn ts change can't orphan one.
 */
export function reactionsForChat(activeReactions: Set<string>, chatId: string): Array<{ key: string; ts: string }> {
  const prefix = `${chatId}:`
  return [...activeReactions]
    .filter((k) => k.startsWith(prefix))
    .map((k) => ({ key: k, ts: k.slice(prefix.length) }))
}

// Slack error codes meaning the reaction (or its message/channel) is already gone,
// so there is nothing left to remove — safe to stop tracking it.
const REACTION_GONE_CODES = new Set(['no_reaction', 'message_not_found', 'channel_not_found'])

/**
 * After attempting reactions.remove, decide whether the thinking reaction is settled
 * (gone) and can be untracked, or whether the removal failed transiently and the key
 * must stay tracked for a later retry. A Slack reaction never expires, so untracking a
 * still-live reaction strands it forever — default to "not settled" on any unknown error.
 */
export function reactionRemovalSettled(err: unknown): boolean {
  if (err == null) return true // removed successfully
  const code = (err as { data?: { error?: string } })?.data?.error
  return code !== undefined && REACTION_GONE_CODES.has(code)
}

/**
 * Serialize async operations per key: each op chains off the prior op on the same key,
 * so fire-and-forget calls that would otherwise race at the network (e.g. a reaction add
 * from one indicator tick and a remove from the next) apply in call order. Mirrors the
 * per-chat promise-tail idiom used for the message queue in ChatIntegrationManager.
 */
export function createPerKeySerializer(): <T>(key: string, op: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return function run<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve()
    // Run op regardless of whether the prior op resolved or rejected, so one failed op
    // doesn't stall the rest of the queue.
    const result = prev.then(op, op)
    const tail = result.catch(() => {}) // swallow so the chain itself never rejects
    tails.set(key, tail)
    // Evict once settled, but only if a newer op hasn't already replaced this tail.
    void tail.finally(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return result
  }
}

// ── Connector ───────────────────────────────────────────────────────────

export class SlackConnector extends ChatClientConnector {
  readonly provider = 'slack' as const

  static generateSystemPrompt = buildSlackSystemPrompt
  static discoveryCapabilities = ['list_users', 'list_channels', 'dm_by_user_id'] as const
  static classifyChatId = classifySlackChatId

  private app: SlackApp | null = null
  private receiver: SocketModeReceiver | null = null
  private connected = false
  private botUserId: string | null = null

  // Own reconnect loop (mirrors IMessageConnector). The receiver is built with
  // autoReconnectEnabled: false, so every socket drop lands here instead of in
  // @slack/socket-mode's internal loop — which leaks unrecoverable reconnect
  // failures as unhandled promise rejections (delayReconnectAttempt's
  // `cb.apply(this).then(res)` has no .catch), fatal at the app level.
  private disconnecting = false
  // Only reconnect a socket that fully started once: a failed INITIAL connect
  // is the manager's to retry — its late 'disconnected' event must not start a
  // zombie loop on a connector object the manager already discarded.
  private started = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // The restart attempt currently in flight, if any. disconnect() can only
  // clear the TIMER; an attempt already awaiting apps.connections.open has no
  // socket yet, so socket-mode's disconnect() resolves without touching it —
  // and the pending start would otherwise OPEN a socket after teardown
  // finished. That ownerless socket still acks its share of round-robin
  // events, silently eating messages meant for the replacement connector.
  private restartInFlight: Promise<void> | null = null
  private reconnectAttempts = 0
  private static readonly BASE_RECONNECT_DELAY_MS = 1_000
  private static readonly MAX_RECONNECT_DELAY_MS = 60_000

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
  private activeReactions: Set<string> = new Set() // effectiveChatId:ts

  // Serialize reaction add/remove per chat so a paint (add) from one indicator tick and
  // a clear (remove) from the next don't race at the network and re-strand the reaction.
  private runReaction = createPerKeySerializer()

  // Thread context: maps effective chatId → real channel + thread anchor ts (for answerInThread)
  private threadContextMap: Map<string, { channel: string; threadTs: string }> = new Map()
  // Tracks threads the bot has participated in (for allowing thread replies without re-mention)
  private activeThreads: Set<string> = new Set() // channelId|threadTs
  // Upper bound on tracked threads (per-collection) so a long-running connector in
  // a busy workspace can't grow threadContextMap/activeThreads without limit. Evicts
  // least-recently-touched threads; an evicted thread just re-fetches history /
  // requires a re-mention if it ever resurfaces.
  private static readonly MAX_TRACKED_THREADS = 1000

  constructor(private config: SlackConfig) {
    super()
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.disconnecting = false
    this.started = false
    this.reconnectAttempts = 0

    // Fail fast on the underlying API calls (auth.test, apps.connections.open):
    // retry pacing belongs to our loop below and to the manager's health-check
    // backstop, not to a WebClient silently retrying for half an hour while the
    // manager waits on connect(). The 30s timeout matters too: WebClient's
    // default is 0 (unbounded), so a blackholed request would otherwise wedge
    // a connect/reconnect attempt for as long as the OS keeps the TCP open.
    //
    // Locals throughout this method: disconnect() nulls this.app/this.receiver,
    // and a disconnect racing this connect used to turn that into a TypeError
    // ("Cannot read properties of null") mid-flight (ELECTRON-3T's signature).
    const receiver = new SocketModeReceiver({
      appToken: this.config.appToken,
      autoReconnectEnabled: false,
      logLevel: 'warn' as any,
      installerOptions: { clientOptions: { retryConfig: { retries: 2 }, timeout: 30_000 } },
    })
    const app = new SlackApp({
      token: this.config.botToken,
      receiver,
      logLevel: 'warn' as any,
      clientOptions: { retryConfig: { retries: 2 }, timeout: 30_000 },
    })
    this.receiver = receiver
    this.app = app

    // Catch-all for events we don't explicitly handle (Bolt requires ack for all events)
    app.event(/.*/, async (_ctx: any) => {
      // No-op — just acknowledge so Slack doesn't retry/disconnect
    })

    // Handle incoming messages
    app.message(async ({ message, say: _say }: { message: any; say: any }) => {
      // Skip bot messages, edits, etc. — but allow file_share (user sent an image/file)
      const subtype = (message as any).subtype
      if (!message || (subtype && subtype !== 'file_share')) return
      const msg = message as any

      const rawText = msg.text || ''
      const chatId = msg.channel || ''
      const userId = msg.user || ''
      const ts = msg.ts || ''
      const threadTs = msg.thread_ts as string | undefined

      const routing = routeSlackMessage({
        rawText,
        chatId,
        ts,
        channelType: msg.channel_type || '',
        threadTs,
        botUserId: this.botUserId,
        config: this.config,
        activeThreads: this.activeThreads,
      })

      if (!routing.shouldProcess) return

      // routeSlackMessage decides this against activeThreads before we mark the
      // thread active below, so read it now rather than recomputing post-add.
      const isNewThreadEntry = routing.isNewThreadEntry

      const effectiveChatId = routing.effectiveChatId
      // Record the reply destination and mark the thread active (both bounded — see
      // MAX_TRACKED_THREADS). For in-thread replies the destination is also encoded
      // in effectiveChatId (composite id), so resolveSlackChannel can recover it by
      // parsing even if this map entry is later evicted or overwritten — no stale
      // entry can misroute a concurrent reply, so there's nothing to clear here.
      if (routing.threadContext) {
        touchAndCapMap(this.threadContextMap, effectiveChatId, routing.threadContext, SlackConnector.MAX_TRACKED_THREADS)
      }
      if (routing.threadKey) {
        touchAndCapSet(this.activeThreads, routing.threadKey, SlackConnector.MAX_TRACKED_THREADS)
      }

      // Track message ts for reaction-based typing (bounded: in-thread sessions
      // make effectiveChatId per-thread, so this would otherwise grow with threads).
      touchAndCapMap(this.lastUserMessageTs, effectiveChatId, ts, SlackConnector.MAX_TRACKED_THREADS)

      // Resolve real user and channel names
      const userName = await this.resolveUserName(userId)
      const chatName = await this.resolveChannelName(chatId)

      // Resolve <@U123>, <#C123|name>, links, and special mentions in the text
      let text = await this.resolveMentionsInText(rawText)

      // When joining a thread mid-conversation, fetch earlier messages as context.
      // isNewThreadEntry already implies threadTs is set; the check narrows the type.
      if (isNewThreadEntry && threadTs) {
        const history = await this.fetchThreadHistory(chatId, threadTs, ts)
        if (history) text = history + '\n\n' + text
      }

      // Handle file uploads
      const files = msg.files?.map((f: any) => ({
        name: f.name || 'file',
        url: f.url_private_download || f.url_private || f.permalink || '',
        mimeType: f.mimetype,
      }))

      this.emitMessage({
        externalMessageId: ts,
        text,
        chatId: effectiveChatId,
        userId,
        userName,
        chatName,
        files: files?.length ? files : undefined,
        timestamp: new Date(Number(ts) * 1000),
      })
    })

    // Handle button clicks (interactive actions)
    app.action(/^cb_\d+$/, async ({ ack, action, body }: { ack: any; action: any; body: any }) => {
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
      const authResult = await app.client.auth.test()
      if (!authResult.ok) {
        throw new Error(`Slack auth.test failed: ${authResult.error}`)
      }
      this.botUserId = authResult.user_id || null
      console.log(`[SlackConnector] Authenticated as ${authResult.user} in workspace ${authResult.team}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Slack bot token invalid: ${msg}`)
    }

    // Track the real socket state so isConnected() is honest — the manager's
    // health check is blind without this.
    const client = receiver.client
    client.on('connected', () => {
      // A 'connected' arriving after disconnect() began is a socket that
      // outlived its owner (a start() that was mid-flight during teardown) —
      // it is being closed, and must not flip a torn-down connector "live".
      if (this.disconnecting) return
      this.connected = true
      this.reconnectAttempts = 0
    })
    client.on('disconnected', () => {
      this.connected = false
      if (!this.disconnecting && this.started) this.scheduleReconnect()
    })

    // Start Socket Mode (requires valid app-level token with connections:write)
    try {
      await app.start()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Slack Socket Mode failed to start (check app-level token and connections:write scope): ${msg}`)
    }
    // disconnect() may have raced this connect (user pause, manager teardown):
    // its app.stop() ran against a socket that didn't exist yet, so the one
    // that just opened is ownerless — close it and report the connect failed.
    if (this.disconnecting) {
      await app.stop().catch(() => {})
      throw new Error('Slack connector was disconnected during connect')
    }
    this.started = true
    this.connected = true
    console.log('[SlackConnector] Socket Mode connected')
  }

  /**
   * Restart the Socket Mode client with exponential backoff after an
   * unexpected disconnect. Transient failures re-schedule; unrecoverable auth
   * failures (dead workspace / revoked tokens) stop the loop and surface via
   * onError so the manager can badge the integration and eventually auto-pause.
   */
  private scheduleReconnect(): void {
    if (this.disconnecting || this.reconnectTimer) return
    this.reconnectAttempts++
    const delay = Math.min(
      SlackConnector.BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      SlackConnector.MAX_RECONNECT_DELAY_MS,
    )
    console.log(`[SlackConnector] Socket closed — reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.disconnecting || !this.receiver) return
      const client = this.receiver.client
      const attempt = client.start()
        .then(() => {
          if (this.disconnecting) {
            // Teardown began while this attempt was awaiting its connection —
            // the socket that just opened has no owner. Close it (socket-mode's
            // disconnect() never rejects).
            void client.disconnect()
            return
          }
          // The 'connected' listener already restored state.
          console.log('[SlackConnector] Socket Mode reconnected')
        })
        .catch((err: unknown) => {
          if (this.disconnecting) return
          if (isUnrecoverableSlackError(err)) {
            console.error('[SlackConnector] Unrecoverable Slack error — stopping reconnect loop:', err)
            this.emitError(err instanceof Error ? err : new Error(String(err)))
            return
          }
          // A websocket-stage failure rejects with undefined (socket-mode's
          // close handler carries no error) — name it for the log.
          console.warn(`[SlackConnector] Reconnect attempt ${this.reconnectAttempts} failed:`, err instanceof Error ? err.message : err ?? 'socket closed before connecting')
          this.scheduleReconnect()
        })
        .finally(() => {
          if (this.restartInFlight === attempt) this.restartInFlight = null
        })
      this.restartInFlight = attempt
    }, delay)
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true
    this.connected = false

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // Capture any restart already past its timer: it can't be cancelled, only
    // waited out — its own success handler closes the socket it opens now that
    // disconnecting is set (see restartInFlight).
    const restart = this.restartInFlight

    // Remove any active reactions (before clearing thread context needed to resolve channels)
    for (const key of this.activeReactions) {
      const [effectiveChatId, ts] = key.split(':')
      const { channel } = this.resolveChannel(effectiveChatId)
      this.removeThinkingReaction(channel, ts).catch(() => {})
    }
    this.activeReactions.clear()
    this.actionDataMap.clear()
    this.pendingQuestions.clear()
    this.lastUserMessageTs.clear()
    this.threadContextMap.clear()
    this.activeThreads.clear()
    this.userNameCache.clear()
    this.channelNameCache.clear()

    if (this.app) {
      await this.app.stop()
      this.app = null
    }
    this.receiver = null
    // Wait for a mid-flight restart to settle: app.stop() resolves while the
    // pending start is still awaiting apps.connections.open (no socket exists
    // for it to close), and the start can OPEN a socket after this point. Its
    // success handler tears that late socket down; don't report "disconnected"
    // until it has.
    if (restart) await restart.catch(() => {})
    console.log('[SlackConnector] Disconnected')
  }

  isConnected(): boolean {
    return this.connected
  }

  // ── Message sending ─────────────────────────────────────────────────

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<string> {
    if (!this.app) throw new Error('Slack app not connected')

    const { channel, threadTs } = this.resolveChannel(chatId)
    const mrkdwn = markdownToSlackMrkdwn(message.text || '(empty message)')
    const chunks = splitChatMessage(mrkdwn, MAX_MESSAGE_LENGTH)

    let lastTs = ''
    for (const chunk of chunks) {
      const result = await this.app.client.chat.postMessage({
        channel,
        text: chunk,
        mrkdwn: true,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      })
      lastTs = result.ts || ''
    }

    // Remove thinking reaction now that we've sent a real message
    await this.clearThinkingReaction(chatId)

    return lastTs
  }

  async sendFile(chatId: string, fileData: Buffer, filename: string, caption?: string): Promise<string> {
    if (!this.app) throw new Error('Slack app not connected')

    const { channel, threadTs } = this.resolveChannel(chatId)
    const result = await this.app.client.filesUploadV2({
      channel_id: channel,
      file: fileData,
      filename,
      initial_comment: caption,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    } as any)

    // filesUploadV2 returns files array; extract the message ts if available
    const file = (result as any).files?.[0]
    return file?.shares?.public?.[channel]?.[0]?.ts || file?.shares?.private?.[channel]?.[0]?.ts || ''
  }

  async sendStreamingUpdate(chatId: string, text: string, existingMessageId?: string): Promise<string> {
    if (!this.app) throw new Error('Slack app not connected')

    const { channel, threadTs } = this.resolveChannel(chatId)
    const truncated = text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH - 60) + '\n\n... (full response will appear when done)'
      : text
    const displayText = markdownToSlackMrkdwn(truncated || ':hourglass_flowing_sand: Thinking...')

    if (!existingMessageId) {
      const result = await this.app.client.chat.postMessage({
        channel,
        text: displayText,
        mrkdwn: true,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      })
      return result.ts || ''
    }

    // Edit existing message
    try {
      await this.app.client.chat.update({
        channel,
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

    const { channel, threadTs } = this.resolveChannel(chatId)
    const mrkdwn = markdownToSlackMrkdwn(finalText || '(empty response)')
    const chunks = splitChatMessage(mrkdwn, MAX_MESSAGE_LENGTH)

    try {
      await this.app.client.chat.update({
        channel,
        ts: messageId,
        text: chunks[0],
      })

      for (let i = 1; i < chunks.length; i++) {
        await this.app.client.chat.postMessage({
          channel,
          text: chunks[i],
          mrkdwn: true,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        })
      }
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

  async startWorking(chatId: string, _activity: SessionActivity): Promise<void> {
    if (!this.app) return

    // Slack's surface is a single reaction, so it can't show distinct labels —
    // the activity is intentionally ignored here (coarse "busy" fidelity).
    // Slack doesn't support typing indicators for bots.
    // Workaround: add a :thinking_face: reaction to the user's last message.
    // The reaction persists until removed, so no keep-alive timer is needed.
    const lastTs = this.lastUserMessageTs.get(chatId)
    if (!lastTs) return

    const key = `${chatId}:${lastTs}`
    if (this.activeReactions.has(key)) return // Already reacting

    const { channel } = this.resolveChannel(chatId)
    // Track BEFORE the network call: an add that lands on Slack but whose response is
    // lost (timeout after commit) would otherwise leave a live reaction that no teardown
    // sweep knows about, so it never clears. Tracking first means the sweep always sees
    // it; a spurious remove of one that never landed is a harmless no-op.
    this.activeReactions.add(key)
    await this.runReaction(chatId, async () => {
      try {
        await this.app?.client.reactions.add({
          channel,
          timestamp: lastTs,
          name: 'thinking_face',
        })
      } catch {
        // Already reacted or message deleted — non-critical. The key stays tracked so the
        // teardown sweep will attempt (and harmlessly no-op) a remove.
      }
    })
  }

  async stopWorking(chatId: string): Promise<void> {
    await this.clearThinkingReaction(chatId)
  }

  // ── User request cards ──────────────────────────────────────────────

  async sendUserRequestCard(chatId: string, event: UserRequestEvent): Promise<string> {
    if (!this.app) throw new Error('Slack app not connected')

    const { channel, threadTs } = this.resolveChannel(chatId)
    const threadOpt = threadTs ? { thread_ts: threadTs } : {}

    if (isUnsupportedInChat(event)) {
      const result = await this.app.client.chat.postMessage({
        channel,
        text: `_${describeUnsupportedRequest(event)}_`,
        mrkdwn: true,
        ...threadOpt,
      })
      return result.ts || ''
    }

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
            channel,
            text: q.question, // Fallback text
            blocks,
            ...threadOpt,
          })
          lastTs = result.ts || ''
        }

        return lastTs
      }

      // secret_request / file_request are handled by the isUnsupportedInChat early-return above
      // (desktop-only fallback); they intentionally have no prompt case here.

      case 'file_delivery': {
        // File transfer from container to chat is not yet supported — show metadata only
        const result = await this.app.client.chat.postMessage({
          channel,
          text: `*File delivered:* \`${event.filePath}\`${event.description ? `\n${event.description}` : ''}\n\n_File download not yet supported — view in the app._`,
          mrkdwn: true,
          ...threadOpt,
        })
        return result.ts || ''
      }

      case 'tool_status': {
        const emoji = event.status === 'success' ? ':white_check_mark:'
          : event.status === 'error' ? ':x:'
          : event.status === 'cancelled' ? ':no_entry_sign:'
          : ':hourglass_flowing_sand:'
        const result = await this.app.client.chat.postMessage({
          channel,
          text: `:wrench: *${event.toolName}* — \`${event.summary}\` ${emoji}`,
          mrkdwn: true,
          ...threadOpt,
        })
        return result.ts || ''
      }

      default: {
        const result = await this.app.client.chat.postMessage({
          channel,
          text: `_${describeUnsupportedRequest(event)}_`,
          mrkdwn: true,
          ...threadOpt,
        })
        return result.ts || ''
      }
    }
  }

  // ── Directory discovery ─────────────────────────────────────────────

  // Cap on directory listings so a large workspace can't flood an agent's
  // context; pages of 200 match Slack's recommended page size.
  private static readonly MAX_DIRECTORY_ENTRIES = 500
  private static readonly DIRECTORY_PAGE_SIZE = 200

  async listChatUsers(): Promise<ChatDirectoryPage<ChatDirectoryUser>> {
    if (!this.app) throw new Error('Slack app not connected')

    const users: ChatDirectoryUser[] = []
    let truncated = false
    let cursor: string | undefined
    do {
      const result = await this.app.client.users.list({
        limit: SlackConnector.DIRECTORY_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      })
      for (const member of result.members ?? []) {
        // Directory = reachable people: skip deactivated accounts, bots, and
        // Slackbot (a bot in every workspace that users.list doesn't flag).
        if (!member.id || member.deleted || member.is_bot || member.id === 'USLACKBOT') continue
        if (users.length >= SlackConnector.MAX_DIRECTORY_ENTRIES) {
          truncated = true
          break
        }
        const title = member.profile?.title
        users.push({
          id: member.id,
          name: member.profile?.real_name || member.real_name || member.name || member.id,
          ...(title ? { title } : {}),
        })
      }
      cursor = truncated ? undefined : (result.response_metadata?.next_cursor || undefined)
    } while (cursor)

    return { items: users, truncated }
  }

  async listChatChannels(): Promise<ChatDirectoryPage<ChatDirectoryChannel>> {
    if (!this.app) throw new Error('Slack app not connected')

    const channels: ChatDirectoryChannel[] = []
    let truncated = false
    let cursor: string | undefined
    do {
      const result = await this.app.client.conversations.list({
        limit: SlackConnector.DIRECTORY_PAGE_SIZE,
        exclude_archived: true,
        types: 'public_channel,private_channel',
        ...(cursor ? { cursor } : {}),
      })
      for (const channel of result.channels ?? []) {
        if (!channel.id || !channel.name) continue
        if (channels.length >= SlackConnector.MAX_DIRECTORY_ENTRIES) {
          truncated = true
          break
        }
        channels.push({
          id: channel.id,
          name: `#${channel.name}`,
          isPrivate: !!channel.is_private,
          isMember: !!channel.is_member,
        })
      }
      cursor = truncated ? undefined : (result.response_metadata?.next_cursor || undefined)
    } while (cursor)

    return { items: channels, truncated }
  }

  async resolveDirectChat(userId: string): Promise<string> {
    if (!this.app) throw new Error('Slack app not connected')

    // conversations.open returns the existing 1:1 when there is one and only
    // otherwise creates it — resolving is idempotent and side-effect-light.
    const result = await this.app.client.conversations.open({ users: userId })
    const channelId = result.channel?.id
    if (!channelId) {
      throw new Error(`Slack did not return a DM channel for user ${userId}`)
    }
    return channelId
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private resolveChannel(effectiveChatId: string): { channel: string; threadTs?: string } {
    return resolveSlackChannel(effectiveChatId, this.threadContextMap)
  }

  /**
   * Fetch earlier messages from a thread the bot is joining mid-conversation.
   * Returns formatted history or null on failure (graceful — works without extra scopes).
   */
  private async fetchThreadHistory(channel: string, threadTs: string, currentMessageTs: string): Promise<string | null> {
    if (!this.app) return null
    try {
      const result = await this.app.client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 50,
      })
      if (!result.ok || !result.messages) return null

      const previous = result.messages.filter(m => m.ts !== currentMessageTs)
      if (previous.length === 0) return null

      const lines: string[] = []
      for (const m of previous) {
        const name = m.user ? (await this.resolveUserName(m.user) || m.user) : 'Unknown'
        const text = m.text ? await this.resolveMentionsInText(m.text) : ''
        if (text) lines.push(`${name}: ${text}`)
      }
      if (lines.length === 0) return null

      const label = lines.length === 1 ? '1 previous message' : `${lines.length} previous messages`
      return `[Thread context — ${label}]\n${lines.join('\n')}`
    } catch (err) {
      console.warn('[SlackConnector] Failed to fetch thread history (non-critical):', err instanceof Error ? err.message : err)
      return null
    }
  }

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
    // Sweep EVERY tracked reaction for the chat, not just the current ts: if a second
    // message landed mid-turn the ts changed and a second reaction was added, so
    // clearing only the latest would orphan the first.
    const entries = reactionsForChat(this.activeReactions, chatId)
    if (entries.length === 0) return

    const { channel } = this.resolveChannel(chatId)
    await this.runReaction(chatId, async () => {
      for (const { key, ts } of entries) {
        const settled = await this.removeThinkingReaction(channel, ts)
        // Only stop tracking once the reaction is confirmed gone. A transient failure
        // keeps the key so the next clear retries — a Slack reaction never self-expires,
        // so dropping tracking on a failed remove would strand it forever.
        if (settled) this.activeReactions.delete(key)
      }
    })
  }

  // Returns whether the reaction is settled (gone) and can be untracked; false on a
  // transient failure that leaves it possibly-live, so the caller keeps it for retry.
  private async removeThinkingReaction(channel: string, ts: string): Promise<boolean> {
    if (!this.app) return false
    try {
      await this.app.client.reactions.remove({
        channel,
        timestamp: ts,
        name: 'thinking_face',
      })
      return true
    } catch (err) {
      return reactionRemovalSettled(err)
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

  // Convert Slack mention syntax (<@U123>, <#C123|name>, <url|label>, <!here>) into plain text.
  private async resolveMentionsInText(text: string): Promise<string> {
    if (!text) return text
    let out = text
    // Resolve user mentions in parallel
    const userIds = Array.from(out.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)).map((m) => m[1])
    const uniqueUserIds = Array.from(new Set(userIds))
    const resolved = await Promise.all(uniqueUserIds.map(async (id) => [id, (await this.resolveUserName(id)) || id] as const))
    const nameById = new Map(resolved)
    out = out.replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_full, id, alt) => {
      const name = alt || nameById.get(id) || id
      return `@${name}`
    })
    // Channel links
    out = out.replace(/<#[CG][A-Z0-9]+(?:\|([^>]+))?>/g, (_full, name) => name ? `#${name}` : '#channel')
    // Special mentions
    out = out.replace(/<!(channel|here|everyone)>/g, '@$1')
    // Slack URL formatting: <url|label> → "label (url)", <url> → "url"
    out = out.replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, '$2 ($1)')
    out = out.replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    return out
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
      const name = channel?.is_im ? undefined : (channel?.name ? `#${channel.name}` : undefined)
      if (name) this.channelNameCache.set(channelId, { value: name, ts: Date.now() })
      return name
    } catch {
      return undefined
    }
  }

}
