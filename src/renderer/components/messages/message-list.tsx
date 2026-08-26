
import { useMessages, useDeleteMessage, useDeleteToolCall, useCancelQueuedMessage, TranscriptNotFoundError } from '@renderer/hooks/use-messages'
import { useAgent } from '@renderer/hooks/use-agents'
import { useIsVoiceAgentConfigured } from '@renderer/hooks/use-voice-input'
import { VoiceAgentFeedbackDialog } from './voice-agent-feedback-dialog'
import {
  useMessageStream,
  clearCompacting,
  removePeerUserMessage,
  clearPeerUserMessages,
  consumeDiscardedCommand,
} from '@renderer/hooks/use-message-stream'
import { isInterruptMarkerMessage, isTurnStartingUserMessage, type PendingMessage } from './pending-message'
import { MessageItem } from './message-item'
import { ToolCallItem, StreamingToolCallItem } from './tool-call-item'
import { ThinkingBlockItem } from './thinking-block-item'
import { SubAgentBlock } from './subagent-block'
import { WorkflowBlock } from './workflow-block'
import { CompactBoundaryItem } from './compact-boundary-item'
import { MemoryRecallItem } from './memory-recall-item'
import { InformationalItem } from './informational-item'
import { isSessionTimeGap, SessionTimeFlag } from './session-time-flag'
import { MessageErrorBoundary } from './message-error-boundary'
import { ArrowDown, ChevronRight, FileX2, Loader2, MessageSquarePlus, WifiOff } from 'lucide-react'
import { FileDownloadPill } from '@renderer/components/ui/file-download-pill'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { useUser } from '@renderer/context/user-context'
import { appendToSessionDraft, useDraft, useDraftsStore } from '@renderer/context/drafts-context'
import { useWorkflow } from '@renderer/context/workflow-context'
import { useRenderTracker } from '@renderer/lib/perf'
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  Fragment,
  type ReactNode,
} from 'react'
import { formatElapsed } from '@renderer/hooks/use-elapsed-timer'
import type { ApiMessage, ApiCompactBoundary, ApiMemoryRecall, ApiInformational } from '@shared/lib/types/api'
import { isBlockingUserInputToolName } from '@shared/lib/tool-definitions/user-input-tools'
import { useMessageListScroll } from './use-message-list-scroll'
import {
  collectEmbeddedImageAliases,
  reuseEqualEmbeddedImageAliases,
  type EmbeddedImageAliases,
} from '@renderer/lib/parse-tool-result'

// Prefix for system-injected user messages that should be hidden in the UI.
// Keep in sync with SYSTEM_MESSAGE_PREFIX in agent-container/src/claude-code.ts
const SYSTEM_MESSAGE_PREFIX = '[SYSTEM] '

const TURN_WORK_REVEAL_CLASS = 'animate-in fade-in-0 slide-in-from-top-2 duration-200 ease-out motion-reduce:animate-none'

const isManualCompactCommand = (text: string) => /^\/compact(?:\s|$)/.test(text.trim())

interface CompletedTurn {
  id: string
  startMessageId: string
  /** Null during the brief idle window before the streamed final text persists. */
  finalAssistantMessageId: string | null
  /** The final textual response for this visual work phase. */
  answerMessageIds: ReadonlySet<string>
  /** Tool cards on the answer message that appear only after expansion. */
  revealedToolCallIds: ReadonlySet<string>
  elapsedMs: number
  toolCallCount: number
  tokenCount: number
  hasTokenUsage: boolean
}

function TurnSummaryRow({
  turn,
  expanded,
  onToggle,
  onProvideFeedback,
}: {
  turn: CompletedTurn
  expanded: boolean
  onToggle: () => void
  onProvideFeedback?: () => void
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border text-muted-foreground">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 py-3 text-left text-sm tabular-nums transition-colors hover:text-foreground"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse completed turn work' : 'Expand completed turn work'}
        data-testid="turn-summary"
      >
        <span>Worked for {formatElapsed(turn.elapsedMs)}</span>
        <span aria-hidden="true">·</span>
        <span>{turn.toolCallCount} {turn.toolCallCount === 1 ? 'tool call' : 'tool calls'}</span>
        {turn.hasTokenUsage && (
          <>
            <span aria-hidden="true">·</span>
            <span>{turn.tokenCount.toLocaleString('en-US')} tokens</span>
          </>
        )}
        <ChevronRight
          className={`h-4 w-4 shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
      </button>
      {onProvideFeedback && (
        <button
          type="button"
          onClick={onProvideFeedback}
          className="flex shrink-0 items-center gap-1 text-xs transition-colors hover:text-foreground"
        >
          <MessageSquarePlus className="h-3 w-3" />
          <span>Voice feedback</span>
        </button>
      )}
    </div>
  )
}

function DeliveredFiles({ files, agentSlug }: { files: { filePath: string }[]; agentSlug: string }) {
  return (
    <div className="flex flex-wrap gap-1.5 ml-11 -mt-1 pb-1">
      {files.map((file) => (
        <FileDownloadPill key={file.filePath} filePath={file.filePath} agentSlug={agentSlug} />
      ))}
    </div>
  )
}

interface MessageListProps {
  sessionId: string
  agentSlug: string
  pendingUserMessages?: PendingMessage[]
  pendingRequestCount?: number
  /** The pending message materialized (or was restored to the composer) — remove it. */
  onPendingMessageAppeared?: (localId: string) => void
  /** Read-only mirror (chat-integration replay): suppress edit/delete actions and
   *  lift the connector's inline sender prefix into a label. */
  readOnly?: boolean
  /** Hide the scroll affordance while a footer popover overlaps it. */
  suppressScrollToBottom?: boolean
  /** Height of an overlaid footer that the live edge must remain above. */
  bottomInset?: number
}

export function MessageList({ sessionId, agentSlug, pendingUserMessages, pendingRequestCount = 0, onPendingMessageAppeared, readOnly, suppressScrollToBottom = false, bottomInset = 0 }: MessageListProps) {
  useRenderTracker('MessageList')
  const { data: messages, isLoading, error, fetchOlder, hasOlder, isFetchingOlder } = useMessages(sessionId, agentSlug)
  const deleteMessage = useDeleteMessage()
  const deleteToolCall = useDeleteToolCall()
  const cancelQueuedMessage = useCancelQueuedMessage()
  // Ghosts with a cancel request in flight (disables their Cancel button)
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set())
  // Ghosts whose cancel came back cancelled:false — the agent already picked
  // the message up, so cancelling is no longer possible; the ghost will
  // materialize on the next refetch.
  const [pickedUpIds, setPickedUpIds] = useState<Set<string>>(new Set())
  const { user } = useUser()
  const [, setSessionDraft] = useDraft<string>(`session:${sessionId}`)
  // Imperative draft access for restoring undelivered messages at idle (must not
  // re-render this list on every composer keystroke).
  const draftsStore = useDraftsStore()

  const handleRemoveMessage = useCallback(
    (messageId: string) => {
      deleteMessage.mutate({ sessionId, agentSlug, messageId })
    },
    [sessionId, agentSlug, deleteMessage]
  )

  const handleRemoveToolCall = useCallback(
    (toolCallId: string) => {
      deleteToolCall.mutate({ sessionId, agentSlug, toolCallId })
    },
    [sessionId, agentSlug, deleteToolCall]
  )

  // Voice Agent feedback dialog state
  const { data: agentData } = useAgent(agentSlug)
  const hasVoiceConfigured = useIsVoiceAgentConfigured()
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false)
  const [expandedTurnIds, setExpandedTurnIds] = useState<Set<string>>(new Set())

  const handleProvideFeedback = useCallback(() => {
    setFeedbackDialogOpen(true)
  }, [])

  const toggleTurn = useCallback((turnId: string) => {
    setExpandedTurnIds((current) => {
      const next = new Set(current)
      if (next.has(turnId)) next.delete(turnId)
      else next.add(turnId)
      return next
    })
  }, [])

  // Find the latest assistant response (for the voice feedback button).
  const lastAssistantMessageId = useMemo(() => {
    if (!messages) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.type === 'assistant') return m.id
    }
    return null
  }, [messages])

  // Collect plain-text messages for the feedback dialog context
  const plainMessages = useMemo(() => {
    if (!messages) return []
    return messages.filter(
      (m): m is ApiMessage => (m.type === 'user' || m.type === 'assistant')
    )
  }, [messages])

  // Final answers commonly embed the container path reported by a screenshot
  // tool. Resolve only paths that were reported alongside a real image block;
  // the resulting src is either inline image data or this session's media API.
  const previousEmbeddedImageAliasesRef = useRef<EmbeddedImageAliases | null>(null)
  const embeddedImageAliases = useMemo(() => {
    const next = collectEmbeddedImageAliases(
      (messages ?? []).flatMap((item) =>
        item.type === 'assistant'
          ? (item as ApiMessage).toolCalls.map((toolCall) => toolCall.result)
          : []
      ),
      { agentSlug, sessionId }
    )
    const previous = previousEmbeddedImageAliasesRef.current
    const stable = reuseEqualEmbeddedImageAliases(previous, next)
    previousEmbeddedImageAliasesRef.current = stable
    return stable
  }, [messages, agentSlug, sessionId])

  const {
    isActive,
    streamingMessage,
    isStreaming,
    streamingToolUses,
    isCompacting,
    activeSubagents,
    completedSubagents,
    apiErrorCode,
    typingUser,
    peerUserMessages,
    discardedCommandUuids,
    workflows,
    thinkingBlocks,
  } = useMessageStream(sessionId, agentSlug)
  const isOnline = useIsOnline()

  // Auto-open the drawer to a workflow the moment it launches (once per run, only while
  // still active). On reload there's no workflow_started replay, so completed runs won't
  // re-pop — the user opens those from the inline block.
  const { openWorkflow } = useWorkflow()
  const autoOpenedWorkflowsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const w of workflows ?? []) {
      if (!w.completedAt && w.runId && !autoOpenedWorkflowsRef.current.has(w.runId)) {
        autoOpenedWorkflowsRef.current.add(w.runId)
        openWorkflow(w.runId, w.name)
      }
    }
  }, [workflows, openWorkflow])

  const hasPendingMessages = !!pendingUserMessages?.length
  // Pending messages sent from idle start a NEW turn, so the previous turn is
  // over (close elapsed times, no more running tools). Queued ghosts (sent
  // mid-turn) don't end the current turn, and undelivered ghosts never start
  // one — neither may flip turn-derived state.
  const hasTurnStartingPendingMessage = !!pendingUserMessages?.some((p) => !p.queued)

  // Persisted message ids already consumed by a text-fallback match. Prevents
  // one persisted copy from clearing two ghosts with identical text. Exact
  // uuid matches don't need claiming (ids are 1:1). Reset on session switch
  // (keyed remount).
  const claimedMessageIdsRef = useRef(new Set<string>())

  // Materialize optimistic copies. Primary signal: the server-assigned uuid
  // (from the POST response) becomes the JSONL entry id, so a fetched message
  // carrying that id is OUR copy — exact match. Fallback: messages sent
  // mid-turn (queued/steering) are re-id'd by the CLI on enqueue (see
  // normalizeQueuedCommandEntry in session-service), so those — and sends
  // whose POST response hasn't arrived yet — match by trimmed text + arrival
  // window, claiming each persisted id at most once. Manual /compact is the
  // exception: the runtime persists its effect as a compact boundary rather
  // than as a user message, so that boundary materializes the command ghost.
  useEffect(() => {
    if (!messages) return
    const claimed = claimedMessageIdsRef.current
    const findTextMatch = (text: string, notBefore: number) => {
      const trimmed = text.trim()
      return messages.find(
        (m) =>
          m.type === 'user' &&
          !claimed.has(m.id) &&
          (m.content as { text?: string }).text?.trim() === trimmed &&
          new Date(m.createdAt).getTime() >= notBefore
      )
    }
    for (const pending of pendingUserMessages ?? []) {
      let match = pending.uuid ? messages.find((m) => m.id === pending.uuid) : undefined
      // Text fallback only where the uuid can't work: queued messages (CLI
      // re-ids them) and sends still awaiting their POST response.
      if (!match && (pending.queued || !pending.uuid)) {
        match = findTextMatch(pending.text, pending.sentAt - 5000)
        if (match) claimed.add(match.id)
      }
      if (!match && isManualCompactCommand(pending.text)) {
        match = messages.find(
          (m) =>
            m.type === 'compact_boundary' &&
            !claimed.has(m.id) &&
            new Date(m.createdAt).getTime() >= pending.sentAt - 5000
        )
        if (match) claimed.add(match.id)
      }
      if (match) {
        onPendingMessageAppeared?.(pending.localId)
      }
    }
    for (const peer of peerUserMessages) {
      // The server echoes user_message to the sender too; our own echo is
      // redundant with the local pending copy — drop it immediately so it
      // can't linger in stream state (it would suppress the typing indicator).
      if (peer.sender.id === user?.id) {
        removePeerUserMessage(sessionId, peer.uuid)
        continue
      }
      let match = messages.find((m) => m.id === peer.uuid)
      if (!match && peer.queued) {
        match = findTextMatch(peer.content, peer.receivedAt - 5000)
        if (match) claimed.add(match.id)
      }
      if (match) {
        removePeerUserMessage(sessionId, peer.uuid)
      }
    }
  }, [messages, pendingUserMessages, peerUserMessages, onPendingMessageAppeared, sessionId, user?.id])

  // Deterministic ghost rescue: the runtime reported these queued messages
  // dead via command_lifecycle discarded/cancelled (e.g. killed by Stop, or
  // dropped by the interrupt-and-restart an MCP injection does). No grace
  // race — the runtime named the uuid, so restore the ghost's text to the
  // composer right away. Peer ghosts just drop (their own client restores
  // their text). The idle-grace effect below stays as the fallback for
  // runtimes that don't emit lifecycle frames.
  useEffect(() => {
    if (discardedCommandUuids.length === 0) return
    const dead = new Set(discardedCommandUuids)
    const rescued = (pendingUserMessages ?? []).filter((p) => p.uuid && dead.has(p.uuid))
    if (rescued.length > 0) {
      const restored = rescued.map((p) => p.text.trim()).filter(Boolean)
      appendToSessionDraft(draftsStore, sessionId, restored.join('\n\n'), { prepend: true })
      for (const pending of rescued) {
        onPendingMessageAppeared?.(pending.localId)
        consumeDiscardedCommand(sessionId, pending.uuid!)
      }
    }
    for (const peer of peerUserMessages) {
      if (dead.has(peer.uuid)) {
        removePeerUserMessage(sessionId, peer.uuid)
        consumeDiscardedCommand(sessionId, peer.uuid)
      }
    }
  }, [discardedCommandUuids, pendingUserMessages, peerUserMessages, sessionId, draftsStore, onPendingMessageAppeared])

  // Once the session goes idle, our messages still showing as pending are
  // treated as undelivered — the agent was interrupted before picking them
  // up, or the turn ended without consuming them. Restore their text to the
  // composer so the user can edit/resend, and remove the ghosts; drop peer
  // ghosts (we can't restore another user's text into our composer — their
  // own client restores it for them). Messages that WERE delivered clear via
  // the materialize effect above, which prunes them from this list as the
  // post-idle refetch lands. The short grace below gives that refetch a beat
  // to settle so a just-answered message isn't yanked back into the composer.
  // While the agent is active, queued ghosts may wait minutes.
  //
  // EXCEPT: a non-queued pending without a uuid has its POST still in flight
  // — commonly a send into a session whose container is waking, where the
  // server can spend seconds before it accepts the message and broadcasts
  // session_active. Its outcome already has owners (a failed POST restores
  // the text via the composer's catch; a successful one assigns the uuid and
  // materializes above), so restoring it here would yank back a message that
  // is actually mid-delivery — it then lands in the transcript AND sits in
  // the composer, baiting a duplicate resend. Leave those pending.
  //
  // Manual /compact is also not restorable user text. It persists as a compact
  // boundary rather than a user message, and compact_complete can beat the
  // boundary refetch by more than this grace period. Consume its ghost at idle
  // without prepending the command over a draft typed during compaction.
  useEffect(() => {
    if (isActive || ((pendingUserMessages?.length ?? 0) === 0 && peerUserMessages.length === 0)) return
    const undelivered = (pendingUserMessages ?? []).filter((p) => p.queued || p.uuid)
    const timerId = setTimeout(() => {
      if (undelivered.length > 0) {
        const restored = undelivered
          .filter((p) => !isManualCompactCommand(p.text))
          .map((p) => p.text.trim())
          .filter(Boolean)
        if (restored.length > 0) {
          appendToSessionDraft(draftsStore, sessionId, restored.join('\n\n'), { prepend: true })
        }
        for (const pending of undelivered) onPendingMessageAppeared?.(pending.localId)
      }
      clearPeerUserMessages(sessionId)
    }, 1500)
    return () => clearTimeout(timerId)
  }, [pendingUserMessages, peerUserMessages, isActive, onPendingMessageAppeared, sessionId, draftsStore])

  // Visible messages with system-injected entries filtered out (these must not
  // consume window slots, and the windowing operates on what the user can see).
  const visibleMessages = useMemo(() => {
    if (!messages) return []
    return messages.filter((item) => {
      if (item.type === 'user') {
        const msg = item as ApiMessage
        if (msg.content?.text?.startsWith(SYSTEM_MESSAGE_PREFIX)) return false
      }
      return true
    })
  }, [messages])

  // Time flags are derived from all loaded history rather than the trailing DOM
  // window, so scrolling/windowing cannot change which turns qualify. When an
  // older page still exists, the first loaded user is not assumed to be the
  // first user in the session.
  const timeFlagState = useMemo(() => {
    const messageIds = new Set<string>()
    let hasSeenUser = hasOlder
    let hasUserSinceLastAssistant = hasOlder
    let lastAssistantAt: Date | null = null

    for (const item of visibleMessages) {
      if (item.type === 'assistant') {
        const createdAt = new Date(item.createdAt)
        lastAssistantAt = Number.isNaN(createdAt.getTime()) ? null : createdAt
        hasUserSinceLastAssistant = false
        continue
      }

      if (
        item.type !== 'user' ||
        item.queued ||
        isInterruptMarkerMessage(item)
      ) continue

      const createdAt = new Date(item.createdAt)
      if (
        !hasSeenUser ||
        (!hasUserSinceLastAssistant && isSessionTimeGap(createdAt, lastAssistantAt))
      ) {
        messageIds.add(item.id)
      }
      hasSeenUser = true
      hasUserSinceLastAssistant = true
    }

    return {
      messageIds,
      hasSeenUser,
      hasUserSinceLastAssistant,
      lastAssistantAt,
    }
  }, [visibleMessages, hasOlder])

  // Safety net: if isCompacting is true but a NEW compact boundary appears in fetched
  // messages, compaction is done and the SSE compact_complete event was missed.
  // Track the boundary count baseline when not compacting, then detect increases.
  const boundaryCountRef = useRef(0)
  const boundaryCount = useMemo(
    () => messages?.filter(m => m.type === 'compact_boundary').length ?? 0,
    [messages]
  )
  useEffect(() => {
    if (isCompacting && boundaryCount > boundaryCountRef.current) {
      clearCompacting(sessionId)
    }
    if (!isCompacting) {
      boundaryCountRef.current = boundaryCount
    }
  }, [isCompacting, boundaryCount, sessionId])

  // Check if streaming message is already in persisted messages (prevents double-render)
  const isStreamingMessagePersisted = useMemo(() => {
    if (!streamingMessage || !messages?.length) return false

    // Find the last assistant message (backward scan; avoids copying and
    // reversing the whole array on every streaming delta).
    let lastAssistantMessage: ApiMessage | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'assistant') {
        lastAssistantMessage = messages[i] as ApiMessage
        break
      }
    }
    if (!lastAssistantMessage) return false

    // Check if the persisted message text contains the streaming content
    const content = lastAssistantMessage.content as { text?: string } | undefined
    const persistedText = content?.text?.trim() || ''
    const streamingText = streamingMessage.trim()

    // Both texts must be non-empty for comparison
    if (!persistedText || !streamingText) return false

    // If streaming text is a prefix of (or equal to) persisted text, it's already persisted
    // Also check if persisted text starts with streaming text (streaming may be slightly behind)
    return persistedText.startsWith(streamingText) || streamingText.startsWith(persistedText)
  }, [messages, streamingMessage])

  // Filter live thinking blocks to only those NOT yet carried by a persisted
  // message (mirrors unpersistedStreamingToolUses). Once the refetched assistant
  // message arrives with its `thinking` array, the persisted card in MessageItem
  // takes over and the ephemeral one must not double-render. Modern runtimes
  // match by stable message-id + content-index identity. Text-prefix matching
  // remains only when either side predates that identity.
  // Only the current turn's persisted thinking is compared — live blocks are
  // reset on session_active, so a match against an older turn can only be a
  // false positive (the model reusing a stock opener suppresses the live card).
  const unpersistedThinkingBlocks = useMemo(() => {
    if (!thinkingBlocks.length) return thinkingBlocks

    // Opus can emit a signed thinking block with no display text. Keep the
    // placeholder only while that exact block is still open; once thinking_stop
    // arrives, an empty card has nothing useful to show even if the wider turn
    // remains active for a following tool call or response.
    const displayableThinkingBlocks = thinkingBlocks.filter(
      b => b.text.trim() || (isActive && b.endedAt === null)
    )
    if (!displayableThinkingBlocks.length || !messages?.length) return displayableThinkingBlocks

    const persisted: Array<{ id?: string; text: string }> = []
    let interrupted = false
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      // The "[Request interrupted by user]" marker is a user message that ENDS
      // the interrupted turn — breaking on it would collect none of that
      // turn's persisted thinking and let every live block re-render at the
      // end. Keep scanning into the turn it terminated.
      if (isInterruptMarkerMessage(m)) {
        interrupted = true
        continue
      }
      if (isTurnStartingUserMessage(m)) break
      if (m.type === 'assistant' && Array.isArray((m as ApiMessage).thinking)) {
        for (const t of (m as ApiMessage).thinking!) {
          if (typeof t?.text === 'string' && t.text.trim()) {
            persisted.push({
              ...(typeof t.id === 'string' && t.id && { id: t.id }),
              text: t.text.trim(),
            })
          }
        }
      }
    }
    // Once the turn is over and its thinking made it into the transcript, the
    // persisted cards own the display outright. This catches blocks whose
    // streamed text diverged from the transcript (e.g. an SSE reconnect
    // dropped deltas) — text matching would miss them and the leftover card
    // would strand below the persisted message, appearing to "jump" there.
    // An interrupted turn is over even when nothing persisted: the SDK
    // discarded whatever the leftover live blocks hold, so they'd strand.
    if (!isActive && (persisted.length || interrupted)) return []
    return displayableThinkingBlocks.filter(b => {
      const t = b.text.trim()
      const matched = persisted.some(p => {
        // When both sides have an identity, text must not override it: models
        // legitimately reuse stock reasoning across different responses.
        if (b.persistedId && p.id) return b.persistedId === p.id
        // Legacy runtime/transcript fallback. Prefix matching tolerates a live
        // stream that trails the completed transcript.
        return !!t && (p.text.startsWith(t) || t.startsWith(p.text))
      })
      if (matched) return false
      return true
    })
  }, [messages, thinkingBlocks, isActive])

  // Filter streaming tool uses to only those NOT yet in persisted messages
  const unpersistedStreamingToolUses = useMemo(() => {
    if (!streamingToolUses.length || !messages?.length) return streamingToolUses
    const persistedToolIds = new Set<string>()
    for (const m of messages) {
      if (m.type === 'assistant') {
        for (const tc of (m as ApiMessage).toolCalls) {
          persistedToolIds.add(tc.id)
        }
      }
    }
    return streamingToolUses.filter(t => !persistedToolIds.has(t.id))
  }, [messages, streamingToolUses])

  // Collect delivered files for each completed turn.
  const turnDeliveredFiles = useMemo(() => {
    const filesMap = new Map<string, { filePath: string }[]>()
    if (!messages) return filesMap

    let turnFiles: { filePath: string }[] = []
    let lastAssistantMessageId: string | null = null

    for (const msg of messages) {
      if (isTurnStartingUserMessage(msg)) {
        if (lastAssistantMessageId && turnFiles.length > 0) {
          filesMap.set(lastAssistantMessageId, turnFiles)
        }
        turnFiles = []
        lastAssistantMessageId = null
      } else if (msg.type === 'assistant') {
        lastAssistantMessageId = msg.id
        for (const tc of msg.toolCalls) {
          if (tc.name === 'mcp__user-input__deliver_file' && !tc.isError) {
            const input = tc.input as { filePath?: string }
            if (input.filePath) {
              turnFiles.push({ filePath: input.filePath })
            }
          }
        }
      }
    }

    if ((!isActive || hasTurnStartingPendingMessage) && lastAssistantMessageId && turnFiles.length > 0) {
      filesMap.set(lastAssistantMessageId, turnFiles)
    }

    return filesMap
  }, [messages, isActive, hasTurnStartingPendingMessage])

  // If there's unpersisted streaming content, defer the last turn's elapsed time
  // to render after the streaming section (otherwise it appears above the streaming message).
  // Exception: if a pending message exists, streaming belongs to the NEW turn, so the
  // previous turn's elapsed/files should render inline (not deferred after new streaming).
  const deferredElapsedMessageId = useMemo(() => {
    if (!messages || hasTurnStartingPendingMessage) return null
    const hasUnpersistedStreaming =
      (streamingMessage && !isStreamingMessagePersisted) ||
      unpersistedStreamingToolUses.length > 0
    if (!hasUnpersistedStreaming) return null
    // Find the last persisted assistant message — that's where the elapsed time would wrongly appear.
    // But if we hit a user message first, the streaming belongs to a NEW turn and we
    // shouldn't defer the previous turn's elapsed/files.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'assistant') return messages[i].id
      if (isTurnStartingUserMessage(messages[i])) return null
    }
    return null
  }, [messages, hasTurnStartingPendingMessage, streamingMessage, isStreamingMessagePersisted, unpersistedStreamingToolUses])

  // Group persisted history into user-initiated turns, then split each completed
  // turn into visual work phases at queued steering messages. The actual turn
  // remains fully expanded until it completes; afterward each steering message
  // floats between the summary for the work before it and the summary for the
  // work it initiated.
  const hasUnpersistedStreamingMessage =
    !!streamingMessage && !isStreamingMessagePersisted
  const hasUnpersistedStreamingTools = unpersistedStreamingToolUses.length > 0
  const hasUnpersistedThinking = unpersistedThinkingBlocks.length > 0

  const { completedTurns, completedTurnByItemId, collapsedMessageById } = useMemo(() => {
    const turns: CompletedTurn[] = []
    const byItemId = new Map<string, CompletedTurn>()
    const collapsedById = new Map<string, ApiMessage>()
    let actualTurnStartIndex: number | null = null

    const finishWorkPhase = (
      startIndex: number,
      endIndex: number,
      isTerminalPhase: boolean,
      finalTextIsStillStreaming = false,
    ) => {
      if (endIndex <= startIndex + 1) return
      const items = visibleMessages.slice(startIndex, endIndex)
      const start = items[0]
      if (!start || start.type !== 'user') return

      const assistantMessages = items.filter(
        (item): item is ApiMessage => item.type === 'assistant'
      )
      const finalAssistant = assistantMessages[assistantMessages.length - 1]
      if (!finalAssistant) return

      // The persisted tail may already be the completed answer even while an
      // older, divergent live text buffer is still waiting to reconcile. Never
      // hide that tail: at worst it is the latest visible checkpoint until the
      // streamed answer persists, and hiding it loses real output in the
      // queued-message cancellation race.
      const answerMessageIds = new Set([finalAssistant.id])

      // A declined/cancelled user-input request can itself be the terminal
      // output. Keep those historical cards visible, regardless of parallel
      // call order. Ordinary tool work stays behind the phase disclosure.
      const visibleTerminalToolCalls = isTerminalPhase
        ? finalAssistant.toolCalls.filter((toolCall) =>
            isBlockingUserInputToolName(toolCall.name),
          )
        : []
      const visibleTerminalToolCallIds = new Set(
        visibleTerminalToolCalls.map((toolCall) => toolCall.id),
      )
      const revealedToolCallIds = new Set(
        finalAssistant.toolCalls
          .filter((toolCall) => !visibleTerminalToolCallIds.has(toolCall.id))
          .map((toolCall) => toolCall.id),
      )

      const answerHasHiddenThinking =
        finalAssistant.thinking?.some((block) => block.text.trim().length > 0) === true
      const hasCollapsibleWork =
        assistantMessages.some((message) => !answerMessageIds.has(message.id)) ||
        answerHasHiddenThinking ||
        finalAssistant.toolCalls.length > visibleTerminalToolCalls.length
      // Turns with no hidden work don't need a disclosure row, but they also
      // don't need an entry in the completed-turn map: the answer and any
      // terminal user-input outcome already render naturally.
      if (!hasCollapsibleWork) return

      collapsedById.set(finalAssistant.id, {
        ...finalAssistant,
        thinking: undefined,
        toolCalls: visibleTerminalToolCalls,
      })

      let toolCallCount = 0
      let tokenCount = 0
      let hasTokenUsage = false
      for (const message of assistantMessages) {
        for (const toolCall of message.toolCalls) {
          toolCallCount += 1 + (toolCall.subagent?.totalToolUseCount ?? 0)
          if (toolCall.subagent?.totalTokens !== undefined) {
            tokenCount += toolCall.subagent.totalTokens
            hasTokenUsage = true
          }
        }
        if (message.usage) {
          // Match loadSessionUsageTotals: cumulative billed/processed tokens,
          // including the four raw provider usage fields for every response.
          tokenCount +=
            message.usage.inputTokens +
            message.usage.outputTokens +
            message.usage.cacheCreationInputTokens +
            message.usage.cacheReadInputTokens
          hasTokenUsage = true
        }
      }

      const startTime = new Date(start.createdAt).getTime()
      const endTime = new Date(finalAssistant.createdAt).getTime()
      const turn: CompletedTurn = {
        id: start.id,
        startMessageId: start.id,
        finalAssistantMessageId: finalTextIsStillStreaming ? null : finalAssistant.id,
        answerMessageIds,
        revealedToolCallIds,
        elapsedMs:
          Number.isFinite(startTime) && Number.isFinite(endTime)
            ? Math.max(0, endTime - startTime)
            : 0,
        toolCallCount,
        tokenCount,
        hasTokenUsage,
      }
      turns.push(turn)
      for (const item of items) byItemId.set(item.id, turn)
    }

    const finishActualTurn = (endIndex: number, finalTextIsStillStreaming = false) => {
      if (
        actualTurnStartIndex === null ||
        endIndex <= actualTurnStartIndex + 1
      ) return

      let phaseStartIndex = actualTurnStartIndex
      for (let i = actualTurnStartIndex + 1; i < endIndex; i++) {
        const item = visibleMessages[i]
        if (item.type !== 'user' || !item.queued) continue
        finishWorkPhase(phaseStartIndex, i, false)
        phaseStartIndex = i
      }
      finishWorkPhase(
        phaseStartIndex,
        endIndex,
        true,
        finalTextIsStillStreaming,
      )
    }

    for (let i = 0; i < visibleMessages.length; i++) {
      if (!isTurnStartingUserMessage(visibleMessages[i])) continue
      if (actualTurnStartIndex !== null) finishActualTurn(i)
      actualTurnStartIndex = i
    }

    const hasUnreconciledOutput =
      hasUnpersistedStreamingMessage ||
      hasUnpersistedStreamingTools ||
      hasUnpersistedThinking
    if (actualTurnStartIndex !== null && (!isActive || hasTurnStartingPendingMessage)) {
      // session_idle can precede the final messages refetch. Collapse the
      // persisted work immediately, but don't mistake its last interim text
      // for the final answer — the still-streamed final text below owns that.
      finishActualTurn(
        visibleMessages.length,
        hasUnreconciledOutput && !hasTurnStartingPendingMessage,
      )
    }

    return {
      completedTurns: turns,
      completedTurnByItemId: byItemId,
      collapsedMessageById: collapsedById,
    }
  }, [
    visibleMessages,
    hasUnpersistedStreamingMessage,
    hasUnpersistedStreamingTools,
    hasUnpersistedThinking,
    isActive,
    hasTurnStartingPendingMessage,
  ])

  // All scrolling behavior — live-edge following (the owned engine), the
  // new-turn reading-line reserve, windowed rendering of long histories. The
  // domain values passed through exist so the hook re-syncs its reserve on
  // the commits that change transcript layout.
  const {
    scrollRef,
    contentRef,
    contentBodyRef,
    bottomSpacerRef,
    isAtBottom,
    scrollToBottom: handleScrollToBottom,
    windowedMessages,
    hiddenCount,
    handleScroll,
    handleWheelGesture,
    handlePointerDown,
    handleScrollKey,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useMessageListScroll({
    visibleMessages,
    pendingUserMessages,
    bottomInset,
    hasOlder,
    isFetchingOlder,
    fetchOlder,
    isLoading,
    error,
    messages,
    streamingMessage,
    streamingToolUses,
    thinkingBlocks,
    isCompacting,
    pendingRequestCount,
    activeSubagents,
  })

  // Drop expansion state for turns that no longer exist after edits/refetches.
  useEffect(() => {
    const validIds = new Set(completedTurns.map((turn) => turn.id))
    setExpandedTurnIds((current) => {
      if ([...current].every((id) => validIds.has(id))) return current
      return new Set([...current].filter((id) => validIds.has(id)))
    })
  }, [completedTurns])

  // Determine which messages could have tool calls that are still running.
  // Only the trailing assistant messages (after the last user message) can have running tools,
  // and only if the session is active and there's no pending user message (which means user moved on).
  const canHaveRunningToolCalls = useMemo(() => {
    const result = new Set<string>()
    if (!messages || !isActive || hasTurnStartingPendingMessage) return result

    // Walk backwards - only assistant messages after the last turn-starting user
    // message can have running tools (queued mid-turn messages don't end the turn)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isTurnStartingUserMessage(messages[i])) break
      if (messages[i].type === 'assistant') {
        result.add(messages[i].id)
      }
    }
    return result
  }, [messages, isActive, hasTurnStartingPendingMessage])

  // Peer messages still worth showing optimistically: not our own, and the
  // persisted copy (by uuid, or — for queued/steering messages whose uuid the
  // CLI replaces — recent identical text) hasn't been fetched yet.
  const visiblePeerMessages = useMemo(
    () =>
      peerUserMessages.filter(
        (p) =>
          p.sender.id !== user?.id &&
          !messages?.some(
            (m) =>
              m.type === 'user' &&
              (m.id === p.uuid ||
                (p.queued &&
                  (m.content as { text?: string }).text?.trim() === p.content.trim() &&
                  new Date(m.createdAt).getTime() >= p.receivedAt - 5000))
          )
      ),
    [peerUserMessages, messages, user?.id]
  )

  // New-turn ghosts should receive the same flag immediately, before their
  // persisted transcript entry arrives. Process them in their render order and
  // show at most one flag before the next assistant response.
  const optimisticTimeFlagIds = useMemo(() => {
    const ids = new Set<string>()
    let {
      hasSeenUser,
      hasUserSinceLastAssistant,
      lastAssistantAt,
    } = timeFlagState
    const ghosts = [
      ...visiblePeerMessages
        .filter((peer) => !peer.queued)
        .map((peer) => ({ id: peer.uuid, sentAt: peer.receivedAt })),
      ...(pendingUserMessages ?? [])
        .filter((pending) => !pending.queued)
        .map((pending) => ({ id: pending.localId, sentAt: pending.sentAt })),
    ]

    for (const ghost of ghosts) {
      const sentAt = new Date(ghost.sentAt)
      if (
        !hasSeenUser ||
        (!hasUserSinceLastAssistant && isSessionTimeGap(sentAt, lastAssistantAt))
      ) {
        ids.add(ghost.id)
      }
      hasSeenUser = true
      hasUserSinceLastAssistant = true
    }

    return ids
  }, [timeFlagState, visiblePeerMessages, pendingUserMessages])

  // Cancel a queued message before the agent picks it up. cancelled: false
  // means we lost the race — the agent already has the message, so flip the
  // ghost to a picked-up state (no Cancel) until it materializes.
  const handleCancelQueued = useCallback(
    (localId: string, uuid: string) => {
      setCancellingIds((prev) => new Set(prev).add(localId))
      cancelQueuedMessage.mutate(
        { sessionId, agentSlug, uuid },
        {
          onSuccess: ({ cancelled }) => {
            if (cancelled) {
              onPendingMessageAppeared?.(localId)
            } else {
              setPickedUpIds((prev) => new Set(prev).add(localId))
            }
          },
          onSettled: () => {
            setCancellingIds((prev) => {
              const next = new Set(prev)
              next.delete(localId)
              return next
            })
          },
        }
      )
    },
    [cancelQueuedMessage, sessionId, agentSlug, onPendingMessageAppeared]
  )

  // Single render path for both local pending ghosts and peer ghosts.
  const renderGhost = (ghost: {
    key: string
    text: string
    sentAt: number
    queued?: boolean
    sender?: { id: string; name: string; email: string }
    testId?: string
    /** Set for own queued ghosts once the server uuid is known — enables Cancel. */
    onCancel?: () => void
    cancelling?: boolean
    /** A cancel attempt confirmed the agent already has this message. */
    pickedUp?: boolean
  }) => (
    <MessageErrorBoundary key={ghost.key} kind="message" raw={ghost} itemId={`ghost-${ghost.key}`}>
      <div className={ghost.queued ? 'opacity-60' : undefined} data-testid={ghost.testId}>
        <MessageItem
          message={{
            id: ghost.key,
            type: 'user',
            content: { text: ghost.text },
            toolCalls: [],
            createdAt: new Date(ghost.sentAt),
            sender: ghost.sender,
          }}
          agentSlug={agentSlug}
        />
        {ghost.queued ? (
          <div className="flex items-center justify-end gap-2 mt-1 text-xs text-muted-foreground italic">
            <span>{ghost.pickedUp ? 'Picked up by the agent' : 'Queued'}</span>
            {!ghost.pickedUp && ghost.onCancel && (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  className="not-italic underline hover:no-underline disabled:opacity-50"
                  onClick={ghost.onCancel}
                  disabled={ghost.cancelling}
                  data-testid="cancel-queued-message"
                >
                  {ghost.cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </MessageErrorBoundary>
  )

  const renderPendingGhost = (pending: PendingMessage) =>
    renderGhost({
      key: pending.localId,
      text: pending.text,
      sentAt: pending.sentAt,
      queued: pending.queued,
      sender: pending.sender,
      testId: pending.queued ? 'queued-user-message' : 'pending-user-message',
      // Cancellation keys off the server-assigned uuid, so it's available
      // only once the POST response has landed (a sub-second window).
      ...(pending.queued && pending.uuid
        ? {
            onCancel: () => handleCancelQueued(pending.localId, pending.uuid!),
            cancelling: cancellingIds.has(pending.localId),
            pickedUp: pickedUpIds.has(pending.localId),
          }
        : {}),
    })

  const renderPeerGhost = (peer: (typeof peerUserMessages)[number]) =>
    renderGhost({
      key: peer.uuid,
      text: peer.content,
      sentAt: peer.receivedAt,
      queued: peer.queued,
      sender: peer.sender.name
        ? { id: peer.sender.id, name: peer.sender.name, email: peer.sender.email || '' }
        : undefined,
    })

  if (isLoading && !hasPendingMessages) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // The transcript file is gone (e.g. removed by the CLI's retention cleanup)
  // while the session still appears in the nav. Don't show this during the brief
  // new-session window — the creating client has a pendingUserMessage then.
  if (error instanceof TranscriptNotFoundError && !hasPendingMessages) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center">
        <FileX2 className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">Session transcript not found</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          This session&apos;s transcript is no longer available. You can remove it from the list.
        </p>
      </div>
    )
  }

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      {/* A labelled, focusable scroll region is intentional: keyboard users
          need to be able to drive the transcript with its scroll keys. */}
      {/* eslint-disable jsx-a11y/no-noninteractive-tabindex */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <div
        className="overflow-y-auto overscroll-contain h-full"
        style={{ overflowAnchor: 'none' }}
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheelGesture}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onPointerDown={handlePointerDown}
        onKeyDown={handleScrollKey}
        role="region"
        aria-label="Messages"
        tabIndex={0}
        data-testid="message-list"
        data-message-content-area
      >
        <div ref={contentRef} className="mx-auto w-full max-w-[720px] px-4">
        <div
          ref={contentBodyRef}
          className={`space-y-4 ${readOnly ? 'pt-3' : 'pt-[100px]'}`}
          role="log"
          aria-relevant="additions"
          aria-busy={isStreaming || undefined}
        >
        {hiddenCount > 0 && (
          <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
            {hiddenCount} earlier {hiddenCount === 1 ? 'message' : 'messages'} hidden — scroll up to load
          </div>
        )}
        {windowedMessages.map((item, index) => {
          const turn = completedTurnByItemId.get(item.id)
          const expanded = !!turn && expandedTurnIds.has(turn.id)
          const previousItem = index > 0 ? windowedMessages[index - 1] : null
          const previousTurn = previousItem
            ? completedTurnByItemId.get(previousItem.id)
            : undefined
          const showTurnSummary =
            !!turn &&
            item.id !== turn.startMessageId &&
            (!previousTurn ||
              previousTurn.id !== turn.id ||
              previousItem?.id === turn.startMessageId)
          const collapsed = !!turn && !expanded
          const isAssistantItem = item.type === 'assistant'
          const isAnswerMessage =
            !!turn && isAssistantItem && turn.answerMessageIds.has(item.id)
          const hideItem =
            collapsed &&
            isAssistantItem &&
            !isAnswerMessage
          const isRevealedWorkItem =
            expanded &&
            isAssistantItem &&
            !isAnswerMessage

          let renderedItem: ReactNode = null
          if (!hideItem) {
            if (item.type === 'memory_recall') {
              renderedItem = <MemoryRecallItem recall={item as ApiMemoryRecall} />
            } else if (item.type === 'compact_boundary') {
              renderedItem = <CompactBoundaryItem boundary={item as ApiCompactBoundary} />
            } else if (item.type === 'informational') {
              renderedItem = <InformationalItem item={item as ApiInformational} />
            } else {
              const message = item as ApiMessage
              // Collapsed answer shapes are memoized with the turn grouping so
              // streaming deltas don't allocate and re-render past messages.
              const displayedMessage = collapsed
                ? collapsedMessageById.get(message.id) ?? message
                : message
              const messageItem = (
                <>
                  <MessageErrorBoundary kind="message" raw={item} itemId={item.id}>
                    <MessageItem
                      message={displayedMessage}
                      agentSlug={agentSlug}
                      sessionId={sessionId}
                      isSessionActive={canHaveRunningToolCalls.has(item.id)}
                      activeSubagents={activeSubagents}
                      completedSubagents={completedSubagents}
                      onRemoveMessage={readOnly ? undefined : handleRemoveMessage}
                      onRemoveToolCall={readOnly ? undefined : handleRemoveToolCall}
                      readOnly={readOnly}
                      workDetailClassName={
                        expanded && isAnswerMessage
                          ? TURN_WORK_REVEAL_CLASS
                          : undefined
                      }
                      revealedToolCallIds={
                        expanded && isAnswerMessage
                          ? turn.revealedToolCallIds
                          : undefined
                      }
                      embeddedImageAliases={embeddedImageAliases}
                    />
                  </MessageErrorBoundary>
                  {turnDeliveredFiles.has(item.id) && item.id !== deferredElapsedMessageId && (
                    <DeliveredFiles files={turnDeliveredFiles.get(item.id)!} agentSlug={agentSlug} />
                  )}
                </>
              )
              renderedItem = isRevealedWorkItem ? (
                <div
                  className={TURN_WORK_REVEAL_CLASS}
                  data-testid="turn-work-detail"
                >
                  {messageItem}
                </div>
              ) : messageItem
            }
          }

          return (
            <Fragment key={item.id}>
              {showTurnSummary && (
                <TurnSummaryRow
                  turn={turn}
                  expanded={expanded}
                  onToggle={() => toggleTurn(turn.id)}
                  onProvideFeedback={
                    hasVoiceConfigured && turn.finalAssistantMessageId === lastAssistantMessageId
                      ? handleProvideFeedback
                      : undefined
                  }
                />
              )}
              {timeFlagState.messageIds.has(item.id) && (
                <SessionTimeFlag date={new Date(item.createdAt)} />
              )}
              {renderedItem}
            </Fragment>
          )
        })}

        {/* Turn-starting ghosts (sent while idle) — the next turn belongs to
            them, so they render before any streaming content. Queued ghosts
            (sent mid-turn) render at the bottom instead, below the current
            turn's streaming output and running tools. */}
        {visiblePeerMessages.filter((p) => !p.queued).map((peer) => (
          <Fragment key={peer.uuid}>
            {optimisticTimeFlagIds.has(peer.uuid) && (
              <SessionTimeFlag date={new Date(peer.receivedAt)} />
            )}
            {renderPeerGhost(peer)}
          </Fragment>
        ))}
        {pendingUserMessages?.filter((p) => !p.queued).map((pending) => (
          <Fragment key={pending.localId}>
            {optimisticTimeFlagIds.has(pending.localId) && (
              <SessionTimeFlag date={new Date(pending.sentAt)} />
            )}
            <div data-turn-anchor-id={pending.localId}>
              {renderPendingGhost(pending)}
            </div>
          </Fragment>
        ))}

        {/* Typing indicator - shown when ANOTHER user is typing. The server echoes
            user_typing back to the sender too, so exclude our own id (mirrors the
            peer-message self-filter); the peer-list gate keeps our own echoed
            message from suppressing a real peer's indicator. */}
        {typingUser && typingUser.id !== user?.id && visiblePeerMessages.length === 0 && (
          <div data-testid="typing-indicator" className="flex gap-3 flex-row-reverse">
            <div className="h-8 w-8 rounded-full items-center justify-center shrink-0 hidden md:flex bg-primary text-primary-foreground">
              <span className="text-xs font-medium">
                {typingUser.name?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?'}
              </span>
            </div>
            <div className="rounded-lg px-4 py-2 bg-primary text-primary-foreground">
              <span className="animate-pulse tracking-widest">...</span>
            </div>
          </div>
        )}

        {/* Thinking episodes for the current turn — tool-call-style cards, expanded
            and scrollable while streaming, collapsed to a "Thought for Ns" header
            once done. Kept until the refetched persisted message carries the same
            text (see unpersistedThinkingBlocks), then MessageItem's card takes over. */}
        {unpersistedThinkingBlocks.map(block => (
          <MessageErrorBoundary key={block.id} kind="thinking block" raw={block} itemId={`thinking-${block.id}`}>
            <div className="max-w-[80%]">
              <ThinkingBlockItem
                text={block.text}
                startedAt={block.startedAt}
                endedAt={block.endedAt}
                active={isActive && block.endedAt === null}
              />
            </div>
          </MessageErrorBoundary>
        ))}

        {/* Streaming text message - keep visible until persisted data arrives */}
        {streamingMessage && !isStreamingMessagePersisted && (
          <MessageErrorBoundary kind="message" raw={streamingMessage} itemId="streaming">
            <MessageItem
              message={{
                id: 'streaming',
                type: 'assistant',
                content: { text: streamingMessage },
                toolCalls: [],
                createdAt: new Date(),
                ...(apiErrorCode && { apiError: apiErrorCode }),
              }}
              isStreaming={isStreaming}
              agentSlug={agentSlug}
              sessionId={sessionId}
              embeddedImageAliases={embeddedImageAliases}
            />
          </MessageErrorBoundary>
        )}

        {/* Tool use streaming - keep visible until persisted data arrives */}
        {unpersistedStreamingToolUses.map(tool => {
          let inner: ReactNode
          if (tool.ready) {
            let input: Record<string, unknown> = {}
            try { input = JSON.parse(tool.partialInput) } catch { /* use empty */ }
            const syntheticToolCall = { id: tool.id, name: tool.name, input }
            if ((tool.name === 'Task' || tool.name === 'Agent') && sessionId) {
              inner = (
                <SubAgentBlock
                  toolCall={syntheticToolCall}
                  sessionId={sessionId}
                  agentSlug={agentSlug}
                  isSessionActive={isActive}
                  activeSubagent={activeSubagents?.find(s => s.parentToolId === tool.id) ?? null}
                  isCompleted={completedSubagents?.has(tool.id) ?? false}
                />
              )
            } else if (tool.name === 'Workflow') {
              inner = (
                <WorkflowBlock
                  toolCall={syntheticToolCall}
                  activeSubagent={activeSubagents?.find(s => s.parentToolId === tool.id) ?? null}
                  isCompleted={completedSubagents?.has(tool.id) ?? false}
                  runId={workflows?.find(w => w.toolUseId === tool.id)?.runId}
                />
              )
            } else {
              inner = (
                <div className="max-w-[80%]">
                  <ToolCallItem toolCall={syntheticToolCall} agentSlug={agentSlug} sessionId={sessionId} isSessionActive={isActive} />
                </div>
              )
            }
          } else {
            inner = (
              <div className="max-w-[80%]">
                <StreamingToolCallItem
                  name={tool.name}
                  partialInput={tool.partialInput}
                />
              </div>
            )
          }
          return (
            <MessageErrorBoundary key={tool.id} kind="tool call" raw={tool} itemId={tool.id}>
              {inner}
            </MessageErrorBoundary>
          )
        })}

        {/* Deferred delivered files — shown after streaming content */}
        {deferredElapsedMessageId && turnDeliveredFiles.has(deferredElapsedMessageId) && (
          <DeliveredFiles files={turnDeliveredFiles.get(deferredElapsedMessageId)!} agentSlug={agentSlug} />
        )}

        {/* Queued ghosts — waiting for the agent loop to pick them up, so they
            always sit below the current turn's streaming output and tools. */}
        {visiblePeerMessages.filter((p) => p.queued).map(renderPeerGhost)}
        {pendingUserMessages?.filter((p) => p.queued).map(renderPendingGhost)}

        {/* Connection lost warning during active session */}
        {isActive && !isOnline && (
          <div className="flex gap-3">
            <div className="h-8 w-8 rounded-full flex items-center justify-center shrink-0 bg-amber-100 dark:bg-amber-900/30">
              <WifiOff className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex-1 rounded-lg px-4 py-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200">
              Internet connection lost.
              <br />
              <span className="text-xs text-amber-600 dark:text-amber-500">
                The agent may still be running. Messages will appear once connection is restored.
              </span>
            </div>
          </div>
        )}

        {/* Real-time compacting indicator */}
        {isCompacting && (
          <CompactBoundaryItem isCompacting />
        )}

        {/* Pending interactive requests render in the composer slot — see SessionChatColumn. */}
        </div>
        <div
          ref={bottomSpacerRef}
          data-testid="turn-anchor-spacer"
          aria-hidden="true"
          hidden
        />
        {/* Live-edge clearance above the overlaid footer. A real element
            rather than container padding: the follow library's ResizeObserver
            measures the content box, so footer growth must change it. */}
        <div
          data-testid="live-edge-clearance"
          aria-hidden="true"
          style={{ height: bottomInset > 0 ? bottomInset + 16 : 16 }}
        />
        </div>
      </div>
      {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
      {!isAtBottom && !suppressScrollToBottom && (
        <button
          onClick={handleScrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium shadow-lg hover:bg-primary/90 transition-opacity cursor-pointer"
          style={bottomInset > 0 ? { bottom: bottomInset + 16 } : undefined}
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Scroll to bottom
        </button>
      )}

      {/* Voice Agent feedback dialog */}
      <VoiceAgentFeedbackDialog
        open={feedbackDialogOpen}
        onOpenChange={setFeedbackDialogOpen}
        agentInstructions={agentData?.instructions ?? ''}
        messages={plainMessages}
        onSetDraft={setSessionDraft}
      />
    </div>
  )
}

if (__RENDER_TRACKING__) {
  (MessageList as any).whyDidYouRender = true
}
