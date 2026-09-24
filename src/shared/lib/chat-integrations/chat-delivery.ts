import type { ChatAgentIntegration, IncomingMessage } from './chat-agent-integration'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import type { SessionActivity } from '../types/agent'
import type { PendingUserInputRequest } from '../user-input/request-schema'
import { agentRegistry, WorkspaceFileError, workspaceBasename } from '../agent-actor'
import { getToolDefinition } from '../tool-definitions/registry'
import { formatToolName } from '../tool-definitions/types'
import { requestCardFromRegistry } from './request-card'
import { captureException } from '../error-reporting'
const reportError = (err: unknown, operation: string, extra?: Record<string, unknown>, level?: 'error' | 'warning') =>
  captureException(err, { tags: { component: 'chat-integration', operation }, extra, level })

export interface ManagedConnector {
  connector: ChatAgentIntegration
  integration: AgentIntegrationRecord
  chatId: string
  streamingState: {
    currentMessageId: string | null
    accumulatedText: string
    lastUpdateTime: number
  }
  currentToolInput: string
  pendingToolMessages: Array<{ messageId: string; text: string }>
  // Pull-model indicator state. `indicatorShown` makes the clear idempotent so
  // idle ticks make zero connector calls; `indicatorTickTimer` is the per-session
  // sampling tick, alive for the SSE subscription (started on subscribe, cleared
  // on teardown).
  indicatorShown?: boolean
  indicatorTickTimer?: ReturnType<typeof setInterval> | null
  // The session the tick samples; set when the tick is armed (subscribe / wake) so the
  // sleep guard and the health-check backstop can re-read getSessionActivity(sessionId).
  sessionId?: string
  // Pending idle-sleep debounce. Scheduled when the session settles non-busy; when it
  // fires it re-reads activity and stops the tick only if STILL non-busy (so a stale or
  // type-mismatched sleep can't strand a working session). Cleared wherever the tick is.
  sleepTimer?: ReturnType<typeof setTimeout> | null
  // True once the session_error notice has gone out for the current turn, so a
  // turn can't emit duplicate notices.
  turnNotified?: boolean
}

// ── Turn finalize ──────────────────────────────────────────────────────────

/**
 * Commit a turn's streamed text + settle pending tool pills. Indicator-free: the
 * terminal cases (session_idle / session_error) settle the indicator via their own
 * clearIndicator call before finalizing, so this only commits text. Idempotent.
 */
async function finalizeTurn(managed: ManagedConnector): Promise<void> {
  try {
    await finalizeStreaming(managed)
    await resolvePendingToolMessages(managed)
  } catch (err) {
    console.error('[ChatAgentIntegration] Failed to finalize turn:', err)
    reportError(err, 'finalize-turn', { integrationId: managed.integration.id, chatId: managed.chatId })
  }
}

/**
 * A short, user-facing message for a turn that ended in an error. Curated by the
 * SDK error code; never echoes the raw internal error (which can leak file paths,
 * tokens, or stack text into the chat).
 */
function friendlyErrorMessage(apiErrorCode: string | null | undefined): string {
  const code = (apiErrorCode ?? '').toLowerCase()
  if (code.includes('overload')) return '⚠️ The assistant is overloaded right now. Please try again in a moment.'
  if (code.includes('rate') || code.includes('429')) return '⚠️ Hit a rate limit. Please wait a few seconds and try again.'
  if (code.includes('auth') || code.includes('permission')) return '⚠️ The assistant could not authenticate. Please check the integration settings.'
  if (code.includes('context') || code.includes('too_long') || code.includes('too_large') || code.includes('length')) {
    return '⚠️ This conversation got too long for the assistant. Try starting a new conversation.'
  }
  return '⚠️ The assistant hit an error and stopped. Please try again.'
}

/**
 * Activities that show a placeholder ("busy"). 'idle' | 'awaiting' | 'streaming'
 * show none — the surface is owned by the reply or a request card, or there is
 * nothing to show.
 */
export const BUSY_ACTIVITIES: ReadonlySet<SessionActivity> = new Set([
  'working', 'thinking', 'compacting', 'retrying',
])

/**
 * The ONE thing that PAINTS the working indicator: project the agent's activity
 * onto the connector. Busy activities show a labeled placeholder — re-painted on
 * EVERY call, because on Telegram that re-render is the keep-alive. Non-busy tears
 * it down idempotently. Driven by the per-session tick (the only paint) and the
 * cold-subscribe snapshot. The connector owns how each activity renders (Telegram
 * labels a draft, Slack reacts); the app draws its own indicator and is untouched.
 */
export function reconcileIndicator(managed: ManagedConnector, activity: SessionActivity): void {
  if (BUSY_ACTIVITIES.has(activity)) {
    managed.indicatorShown = true
    managed.connector.startWorking(managed.chatId, activity).catch(() => {})
  } else {
    clearIndicator(managed)
  }
}

/**
 * Idempotent clear: only call the connector when the indicator is currently shown,
 * so repeated clears (idle ticks, several clear events in a row) make ZERO connector
 * calls. Clearing is always EXPLICIT — stopping the tick never clears a persistent
 * draft, so the four immediate clears and the non-busy tick all route through here.
 */
export function clearIndicator(managed: ManagedConnector): void {
  if (!managed.indicatorShown) return
  managed.indicatorShown = false
  managed.connector.stopWorking(managed.chatId).catch(() => {})
}

/** Pull cadence for the indicator tick. At/under Telegram's draft expiry so drafts stay alive. */
export const INDICATOR_TICK_MS = 1000

/**
 * How long after the session settles non-busy the tick is allowed to stop. The sleep is
 * a debounce: any event re-arms (cancels) it, so it only fires after a genuine lull. When
 * it DOES fire it re-reads the live activity and only stops the tick if the session is
 * still non-busy — the same "re-read reality" rule the tick itself follows — so a stale or
 * type-mismatched sleep can never strand a working session.
 */
export const INDICATOR_SLEEP_MS = 10_000

/**
 * Ensure the per-session indicator tick is running, alive for the SSE subscription (NOT a
 * turn). Each tick re-reads the truth (getSessionActivity) and reconciles — the only PAINT,
 * and the self-healing backstop: a stuck or wrong indicator is corrected within one tick. The
 * tick also owns its own idle-sleep (arm on sustained non-busy, cancel on busy), so the settle
 * handlers stay dumb (clear only) and the sleep decision always reads live state.
 * CREATE-IF-ABSENT: a tick already running is left untouched — restarting it on every event
 * would keep pushing the interval back and starve it during a fast event burst, so the
 * Telegram draft would expire mid-turn. Records the sampled session and cancels any pending
 * sleep (activity means we stay awake). Returns true iff it created a new interval (a cold
 * arm) — the caller uses that to paint once immediately so a cold wake isn't blank for a tick.
 */
export function startIndicatorTick(managed: ManagedConnector, sessionId: string): boolean {
  managed.sessionId = sessionId
  cancelIndicatorSleep(managed)
  if (managed.indicatorTickTimer) return false
  managed.indicatorTickTimer = setInterval(() => {
    const activity = agentRegistry.get(managed.integration.agentSlug).sessions.activity(sessionId)
    reconcileIndicator(managed, activity)
    // The tick owns its own sleep: a busy read keeps it awake (cancel any pending stop), the
    // first of a sustained non-busy run starts the debounce. scheduleIndicatorSleep is arm-once,
    // so calling it every non-busy tick never pushes the deadline back.
    if (BUSY_ACTIVITIES.has(activity)) cancelIndicatorSleep(managed)
    else scheduleIndicatorSleep(managed)
  }, INDICATOR_TICK_MS)
  return true
}

/**
 * Arm the tick for a BUSY snapshot, painting once immediately on a cold arm. No-op when the
 * snapshot is non-busy — a per-session timer is created exactly when a busy state is observed,
 * never on a stray non-busy event (which would leave a tick running with nothing to sleep it).
 * The ONE arm primitive behind all three arm sites — subscribe, the per-event wake, and the
 * health-check backstop — so they share one rule: the tick is armed iff busy, and idle holds
 * zero per-session timers. Every busy transition emits a per-session broadcast, so a busy
 * snapshot is always observed in time.
 */
export function armIndicatorIfBusy(managed: ManagedConnector, sessionId: string, activity: SessionActivity): void {
  if (!BUSY_ACTIVITIES.has(activity)) return
  if (startIndicatorTick(managed, sessionId)) reconcileIndicator(managed, activity)
}

/**
 * Stop the per-session tick AND any pending sleep (resource cleanup at unsubscribe /
 * teardown). Clearing both here is what stops an orphaned sleep — scheduled before a
 * re-subscribe — from firing later and killing a freshly re-armed tick.
 */
export function stopIndicatorTick(managed: ManagedConnector): void {
  cancelIndicatorSleep(managed)
  if (managed.indicatorTickTimer) {
    clearInterval(managed.indicatorTickTimer)
    managed.indicatorTickTimer = null
  }
}

/** Cancel a pending idle-sleep, if any. */
export function cancelIndicatorSleep(managed: ManagedConnector): void {
  if (managed.sleepTimer) {
    clearTimeout(managed.sleepTimer)
    managed.sleepTimer = null
  }
}

/**
 * Start the debounce that stops the tick after INDICATOR_SLEEP_MS of confirmed non-busy.
 * ARM-ONCE: a no-op if a countdown is already pending, so the TICK can call this every
 * non-busy second without ever pushing the deadline back — it fires ~10s after the FIRST
 * non-busy tick. A busy tick cancels it (cancelIndicatorSleep), restarting the window. No-op
 * when no tick is running (nothing to sleep). When the timer fires it RE-READS the live
 * activity and stops the tick only if the session is STILL non-busy — so an auto-approved
 * script run (card shown but stays 'working'), or a fresh turn started during the debounce,
 * keeps its tick.
 */
export function scheduleIndicatorSleep(managed: ManagedConnector): void {
  if (!managed.indicatorTickTimer) return
  if (managed.sleepTimer) return
  const sessionId = managed.sessionId
  if (!sessionId) return
  managed.sleepTimer = setTimeout(() => {
    managed.sleepTimer = null
    if (!BUSY_ACTIVITIES.has(agentRegistry.get(managed.integration.agentSlug).sessions.activity(sessionId))) {
      // Clear before stopping: stopIndicatorTick only drops timers, so stopping a tick that
      // is somehow still showing a draft would strand it. Clearing first makes the guard
      // self-defending regardless of how the caller left indicatorShown.
      clearIndicator(managed)
      stopIndicatorTick(managed)
    }
  }, INDICATOR_SLEEP_MS)
}

// ── SSE event processing (exported for testing) ────────────────────────

/**
 * Process a single SSE event for a managed connector.
 * Handles streaming text, tool calls, user request events, and session lifecycle.
 */
export async function processSSEEvent(
  managed: ManagedConnector,
  event: unknown,
  showToolCalls = false,
  sessionId?: string,
): Promise<void> {
  const data = event as Record<string, unknown>
  const eventType = data.type as string

  switch (eventType) {
    case 'stream_delta': {
      const text = data.text as string
      if (!text) break
      // First reply token → 'streaming' (non-busy): the streamed text owns the
      // reply surface, so settle the indicator now. Idempotent; the tick backstops.
      clearIndicator(managed)
      managed.streamingState.accumulatedText += text

      const now = Date.now()
      if (now - managed.streamingState.lastUpdateTime >= 1000) {
        try {
          const msgId = await managed.connector.sendStreamingUpdate(
            managed.chatId,
            managed.streamingState.accumulatedText,
            managed.streamingState.currentMessageId ?? undefined,
          )
          managed.streamingState.currentMessageId = msgId
          managed.streamingState.lastUpdateTime = now
        } catch (err) {
          console.error(`[ChatAgentIntegration] Streaming update failed:`, err)
          reportError(err, 'streaming-update', { integrationId: managed.integration.id, chatId: managed.chatId, provider: managed.integration.provider })
        }
      }
      break
    }

    case 'stream_start': {
      try {
        await finalizeStreaming(managed)
        await resolvePendingToolMessages(managed)
      } catch (err) {
        console.error('[ChatAgentIntegration] Failed to finalize on stream_start:', err)
      }
      break
    }

    case 'tool_use_start': {
      try { await finalizeStreaming(managed) } catch { /* best-effort */ }
      managed.currentToolInput = ''
      break
    }

    case 'tool_use_streaming': {
      const partialInput = data.partialInput as string
      if (partialInput) managed.currentToolInput = partialInput
      break
    }

    case 'tool_use_ready': {
      const toolName = data.toolName as string

      // Note: deliver_file is handled off its tool_result (see 'tool_result_ready'
      // below), not off the streamed input — so we never read a host-side path
      // before the in-container tool has validated the file exists. It falls
      // through to isUserRequestTool() here, which just resets the tool input.

      if (isUserRequestTool(toolName)) {
        managed.currentToolInput = ''
        break
      }

      if (showToolCalls) {
        let toolInput: Record<string, unknown> = {}
        try { toolInput = JSON.parse(managed.currentToolInput) } catch { /* partial/invalid */ }

        const def = getToolDefinition(toolName)
        const displayName = def?.displayName ?? formatToolName(toolName)
        const summary = def?.getSummary(toolInput) ?? ''
        const text = summary
          ? `🔧 *${displayName}* — \`${summary}\` ⏳`
          : `🔧 *${displayName}* ⏳`
        try {
          const messageId = await managed.connector.sendMessage(managed.chatId, { text })
          managed.pendingToolMessages.push({ messageId, text })
        } catch (err) {
          console.error('[ChatAgentIntegration] Failed to send tool call message:', err)
        }
      }
      managed.currentToolInput = ''
      break
    }

    case 'tool_result_ready': {
      // Fired once the in-container tool has returned its result. Currently only
      // deliver_file acts on it: deliver the file to the chat client, but only if
      // the tool validated the file exists (isError === false). On an error
      // result we skip host delivery — the agent's text already covers the user.
      const toolName = data.toolName as string
      if (toolName === 'mcp__user-input__deliver_file' && !data.isError) {
        const filePath = data.filePath as string | undefined
        const description = data.description as string | undefined
        if (filePath) {
          try {
            await sendDeliveredFile(managed, filePath, description)
          } catch (err) {
            console.error('[ChatAgentIntegration] Failed to deliver file:', err)
            reportError(err, 'deliver-file', { integrationId: managed.integration.id, provider: managed.integration.provider })
          }
        }
      }
      break
    }

    case 'user_request_created': {
      // The one wire chat renders cards from. The legacy per-type events still
      // fire alongside this one (they die in Phase 8) and are deliberately NOT
      // handled here — handling both would double-send every card.
      const request = (data as { request?: PendingUserInputRequest }).request
      if (!request) break
      const card = requestCardFromRegistry(request)
      // null = chat stays quiet: a review (agent-scoped, rendered off the
      // global channel) or an auto-approved ask nobody has to decide.
      if (!card) break

      // The agent is now waiting on the user → 'awaiting' (non-busy). Settle the
      // indicator the moment the card is shown (the persister flips isAwaitingInput,
      // so the tick would clear within a tick anyway — this just makes it instant). The
      // tick then sleeps after the lull and re-checks activity at fire time.
      clearIndicator(managed)
      try {
        await managed.connector.sendUserRequestCard(managed.chatId, card, sessionId)
      } catch (err) {
        console.error(`[ChatAgentIntegration] Failed to send user request card (${request.kind}):`, err)
        reportError(err, 'send-user-request-card', { integrationId: managed.integration.id, provider: managed.integration.provider, eventType: card.type })
      }
      break
    }

    case 'user_request_resolved': {
      // Settled — by a decision here, in the app, or by a sweep. Nothing to
      // render: the gate in handleInteractiveResponse is what stops a press on
      // the now-dead card, because no connector can dismiss a single card yet
      // (dismissOpenCards is all-or-nothing, and Slack does not implement it).
      break
    }

    case 'session_idle': {
      // Turn ended → settle the indicator instantly, then finalize the streamed text.
      // The tick sleeps itself once it reads the now-idle state.
      clearIndicator(managed)
      await finalizeTurn(managed)
      break
    }

    case 'session_error': {
      // An errored turn emits session_error (NOT session_idle), and the host
      // suppresses the later authoritative idle. Settle the indicator instantly so
      // it never strands, finalize the turn the same way session_idle does, then
      // surface a curated error so the user isn't left staring at a frozen reply.
      // The tick sleeps itself once it reads the now-idle/non-busy state.
      clearIndicator(managed)
      await finalizeTurn(managed)
      if (!managed.turnNotified) {
        managed.turnNotified = true
        try {
          await managed.connector.sendMessage(managed.chatId, { text: friendlyErrorMessage(data.apiErrorCode as string | null) })
        } catch (err) {
          // Delivery failed — release the latch so a later notice isn't suppressed.
          managed.turnNotified = false
          console.error('[ChatAgentIntegration] Failed to send error message:', err)
        }
      }
      break
    }
  }
}

export async function resolvePendingToolMessages(managed: ManagedConnector): Promise<void> {
  for (const pending of managed.pendingToolMessages) {
    const doneText = pending.text.replace('⏳', '✅')
    try {
      await managed.connector.sendStreamingUpdate(managed.chatId, doneText, pending.messageId)
    } catch {
      // Non-critical
    }
  }
  managed.pendingToolMessages = []
}

export async function finalizeStreaming(managed: ManagedConnector): Promise<void> {
  const finalText = managed.streamingState.accumulatedText
  if (!finalText) return
  const messageId = managed.streamingState.currentMessageId

  // Claim the buffer synchronously, before the first await, so a concurrent
  // finalize (e.g. session_idle finalizing while a late stream_start also
  // finalizes) reads an empty buffer and can't double-send the same text. The
  // reset previously ran only after the await, leaving that window open.
  managed.streamingState = {
    currentMessageId: null,
    accumulatedText: '',
    lastUpdateTime: 0,
  }

  try {
    if (messageId) {
      try {
        await managed.connector.finalizeStreamingMessage(managed.chatId, messageId, finalText)
      } catch {
        await managed.connector.sendMessage(managed.chatId, { text: finalText })
      }
    } else {
      await managed.connector.sendMessage(managed.chatId, { text: finalText })
    }
  } catch (err) {
    // Both delivery attempts failed (chat unreachable) — nothing reached the user.
    // Restore the claimed buffer so a later terminal path can retry, but only if it
    // is still empty, so we never overwrite newer streamed text (a later stream_delta
    // repopulated it). Re-throw so callers log/handle the failure exactly as before.
    if (!managed.streamingState.accumulatedText) {
      managed.streamingState = { currentMessageId: messageId, accumulatedText: finalText, lastUpdateTime: 0 }
    }
    throw err
  }
}

/** Read a file from the agent workspace and send it to the chat client. */
async function sendDeliveredFile(
  managed: ManagedConnector,
  filePath: string,
  description?: string,
): Promise<void> {
  try {
    // filePath is a workspace path as the agent wrote it (`/workspace/output.png`).
    // The actor keeps it inside the workspace: a path that would leave it —
    // through `..` or a link — is refused (status 400) before anything is read.
    const fileData = await agentRegistry.get(managed.integration.agentSlug).files.getDoc(filePath)
    if (fileData === null) {
      // Benign: the file isn't host-visible (e.g. a not-yet-flushed write across
      // the VM file-share). The text fallback below still reaches the user, so
      // don't page Sentry.
      console.error('[ChatAgentIntegration] Delivered file not found:', filePath)
    } else {
      await managed.connector.sendFile(managed.chatId, Buffer.from(fileData), workspaceBasename(filePath), description)
      return
    }
  } catch (err) {
    if (err instanceof WorkspaceFileError && err.status === 400) {
      console.error('[ChatAgentIntegration] deliver_file path escapes workspace:', filePath)
      reportError(new Error('Path traversal attempt in deliver_file'), 'deliver-file-security', { filePath, agentSlug: managed.integration.agentSlug }, 'warning')
      return
    }
    console.error('[ChatAgentIntegration] Failed to send delivered file:', err)
    reportError(err, 'send-delivered-file', { integrationId: managed.integration.id, provider: managed.integration.provider, filePath }, 'warning')
  }
  // Fall back to a text message with the file path
  await managed.connector.sendMessage(managed.chatId, {
    text: `📎 File ready: \`${filePath}\`${description ? ` — ${description}` : ''}\n(File delivery to chat not available — download from the UI)`,
  })
}

// ── Exported pure functions (testable) ────────────────────────────────

const USER_REQUEST_TOOLS = new Set([
  'AskUserQuestion',
  'mcp__user-input__request_secret',
  'mcp__user-input__request_file',
  'mcp__user-input__deliver_file',
  'mcp__user-input__request_connected_account',
  'mcp__user-input__request_remote_mcp',
  'mcp__user-input__request_browser_input',
  'mcp__user-input__request_script_run',
])

export function isUserRequestTool(toolName: string): boolean {
  return USER_REQUEST_TOOLS.has(toolName)
}

/**
 * Derive a human-readable display name from an incoming chat message.
 * Priority: chatName (group/channel title) → userName (DM sender) → userId fallback.
 */
export function deriveDisplayName(message: Pick<IncomingMessage, 'chatName' | 'userName' | 'userId'>): string | undefined {
  return message.chatName || message.userName || (message.userId ? `User ${message.userId}` : undefined)
}

/** Check if a display name looks like the raw-ID fallback (e.g. "User U08G59..."). */
export function isDisplayNameFallback(name: string | null | undefined): boolean {
  return !name || name.startsWith('User ')
}
