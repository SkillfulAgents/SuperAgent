
import { useMessages, useDeleteMessage, useDeleteToolCall, useCancelQueuedMessage, TranscriptNotFoundError } from '@renderer/hooks/use-messages'
import { useAgent } from '@renderer/hooks/use-agents'
import { useIsVoiceAgentConfigured } from '@renderer/hooks/use-voice-input'
import { VoiceAgentFeedbackDialog } from './voice-agent-feedback-dialog'
import {
  useMessageStream,
  clearCompacting,
  removePeerUserMessage,
  clearPeerUserMessages,
} from '@renderer/hooks/use-message-stream'
import { isTurnStartingUserMessage, type PendingMessage } from './pending-message'
import { MessageItem } from './message-item'
import { ToolCallItem, StreamingToolCallItem } from './tool-call-item'
import { SubAgentBlock } from './subagent-block'
import { WorkflowBlock } from './workflow-block'
import { CompactBoundaryItem } from './compact-boundary-item'
import { MemoryRecallItem } from './memory-recall-item'
import { MessageErrorBoundary } from './message-error-boundary'
import { ArrowDown, FileX2, Loader2, MessageSquarePlus, WifiOff } from 'lucide-react'
import { FileDownloadPill } from '@renderer/components/ui/file-download-pill'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { useUser } from '@renderer/context/user-context'
import { useDraft, useDraftsStore } from '@renderer/context/drafts-context'
import { useWorkflow } from '@renderer/context/workflow-context'
import { useRenderTracker } from '@renderer/lib/perf'
import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, Fragment, type ReactNode } from 'react'
import { formatElapsed } from '@renderer/hooks/use-elapsed-timer'
import type { ApiMessage, ApiCompactBoundary, ApiMemoryRecall } from '@shared/lib/types/api'

// Prefix for system-injected user messages that should be hidden in the UI.
// Keep in sync with SYSTEM_MESSAGE_PREFIX in agent-container/src/claude-code.ts
const SYSTEM_MESSAGE_PREFIX = '[SYSTEM] '

// On very long threads we render only a trailing window of messages to keep the
// DOM small. Sessions with <= BASE_WINDOW visible items render in full, so small
// and medium threads are completely unaffected. Scrolling near the top reveals
// LOAD_STEP more at a time. The window is a fixed-size tail slice, so while new
// messages stream in at the bottom the oldest rendered ones drop off the top and
// the DOM node count stays flat. The window only grows on an explicit scroll-up
// and is reset when the session changes.
const BASE_WINDOW = 300
const LOAD_STEP = 200

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
}

export function MessageList({ sessionId, agentSlug, pendingUserMessages, pendingRequestCount = 0, onPendingMessageAppeared }: MessageListProps) {
  useRenderTracker('MessageList')
  const { data: messages, isLoading, error } = useMessages(sessionId, agentSlug)
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

  const handleProvideFeedback = useCallback(() => {
    setFeedbackDialogOpen(true)
  }, [])

  // Find the last assistant message that has an elapsed time (for voice feedback button)
  const lastAssistantElapsedId = useMemo(() => {
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
    workflows,
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
  // window, claiming each persisted id at most once.
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
  useEffect(() => {
    if (isActive || ((pendingUserMessages?.length ?? 0) === 0 && peerUserMessages.length === 0)) return
    const undelivered = (pendingUserMessages ?? []).filter((p) => p.queued || p.uuid)
    const timerId = setTimeout(() => {
      if (undelivered.length > 0) {
        const draftKey = `session:${sessionId}`
        const existing = draftsStore.get<string>(draftKey)?.trim() ?? ''
        const restored = undelivered.map((p) => p.text.trim()).filter(Boolean)
        const merged = [...restored, existing].filter(Boolean).join('\n\n')
        draftsStore.set(draftKey, merged || undefined)
        for (const pending of undelivered) onPendingMessageAppeared?.(pending.localId)
      }
      clearPeerUserMessages(sessionId)
    }, 1500)
    return () => clearTimeout(timerId)
  }, [pendingUserMessages, peerUserMessages, isActive, onPendingMessageAppeared, sessionId, draftsStore])

  const scrollRef = useRef<HTMLDivElement>(null)
  const isScrolledToBottomRef = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  // How many trailing (visible) messages to render. Grows on scroll-up and while
  // the user is scrolled up during streaming. Starts at BASE_WINDOW; the component
  // is keyed by sessionId at its mount site, so a switched session remounts fresh.
  const [windowSize, setWindowSize] = useState(BASE_WINDOW)
  // Scroll height captured just before a scroll-up expansion, used to re-anchor the
  // viewport after the larger slice renders so the content under the user doesn't jump.
  const prevScrollHeightRef = useRef<number | null>(null)

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

  // The trailing slice we actually render. The other derived values below still
  // compute over the FULL message list, so turn boundaries / elapsed times / etc.
  // stay correct even when their anchor message is outside the rendered window.
  const windowedMessages = useMemo(
    () => visibleMessages.slice(-windowSize),
    [visibleMessages, windowSize]
  )
  const hiddenCount = visibleMessages.length - windowedMessages.length

  // Keep the rendered range anchored at the top while the user is scrolled up.
  // The window is a trailing slice, so when new messages are persisted it would
  // normally drop the same number off the top — shifting the content the user is
  // reading (overflow-anchor is disabled, so nothing compensates). Growing the
  // window by exactly that delta keeps the same first rendered item; the new
  // messages just append below, off-screen. When pinned to the bottom we leave the
  // window alone so the slice slides and the DOM stays bounded.
  const prevVisibleLenRef = useRef(visibleMessages.length)
  useLayoutEffect(() => {
    const grown = visibleMessages.length - prevVisibleLenRef.current
    prevVisibleLenRef.current = visibleMessages.length
    if (grown > 0 && !isScrolledToBottomRef.current) {
      setWindowSize((n) => n + grown)
    }
  }, [visibleMessages])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // Consider "at bottom" if within 80px of the bottom edge
    const threshold = 80
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    isScrolledToBottomRef.current = distanceFromBottom < threshold
    // Show "scroll to bottom" button when scrolled up more than 300px
    setShowScrollToBottom(distanceFromBottom > 300)

    // Near the top with older messages still hidden: reveal the next chunk.
    // prevScrollHeightRef doubles as a re-entrancy guard so we expand at most once
    // per scroll gesture; the layout effect clears it after re-anchoring.
    if (el.scrollTop < 200 && prevScrollHeightRef.current == null && hiddenCount > 0) {
      prevScrollHeightRef.current = el.scrollHeight
      // The user is reading older content — make sure nothing auto-pins to the
      // bottom during the expand (the distance heuristic can misfire when the
      // rendered slice barely overflows the viewport).
      isScrolledToBottomRef.current = false
      setWindowSize((n) => n + LOAD_STEP)
    }
  }, [hiddenCount])

  // After a scroll-up expansion adds older messages above the viewport, restore the
  // scroll position so the content the user was reading stays put (no jump).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && prevScrollHeightRef.current != null) {
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current
      prevScrollHeightRef.current = null
    }
  }, [windowSize])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

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

  // Compute elapsed time for each completed response turn
  // A turn starts with a user message and ends at the last assistant message before the next user message (or end of messages when idle)
  const turnElapsedTimes = useMemo(() => {
    const elapsed = new Map<string, number>()
    if (!messages) return elapsed

    let lastUserMessageTime: number | null = null
    let lastAssistantMessageId: string | null = null
    let lastAssistantMessageTime: number | null = null

    for (const msg of messages) {
      // Queued (mid-turn) user messages don't end the turn they appear in
      if (isTurnStartingUserMessage(msg)) {
        // Close previous turn
        if (lastUserMessageTime && lastAssistantMessageId && lastAssistantMessageTime) {
          elapsed.set(lastAssistantMessageId, lastAssistantMessageTime - lastUserMessageTime)
        }
        lastUserMessageTime = new Date(msg.createdAt).getTime()
        lastAssistantMessageId = null
        lastAssistantMessageTime = null
      } else if (msg.type === 'assistant') {
        lastAssistantMessageId = msg.id
        lastAssistantMessageTime = new Date(msg.createdAt).getTime()
      }
    }

    // Close the last turn if session is idle, or if the user has sent a new message
    // (a pending message means a new turn started, so the previous one is complete)
    if ((!isActive || hasTurnStartingPendingMessage) && lastUserMessageTime && lastAssistantMessageId && lastAssistantMessageTime) {
      elapsed.set(lastAssistantMessageId, lastAssistantMessageTime - lastUserMessageTime)
    }

    return elapsed
  }, [messages, isActive, hasTurnStartingPendingMessage])

  // Collect delivered files for each completed turn (same turn boundaries as turnElapsedTimes)
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

  // Re-pin to bottom when the user sends a new message. Track ids actually
  // seen — not a count — so a send racing a ghost removal still re-pins, and
  // a removal alone never yanks a scrolled-up reader back down.
  const seenPendingIdsRef = useRef(new Set<string>())
  useEffect(() => {
    const seen = seenPendingIdsRef.current
    let hasNewSend = false
    for (const pending of pendingUserMessages ?? []) {
      if (!seen.has(pending.localId)) {
        seen.add(pending.localId)
        hasNewSend = true
      }
    }
    if (hasNewSend) {
      isScrolledToBottomRef.current = true
      setShowScrollToBottom(false)
    }
  }, [pendingUserMessages])

  // Auto-scroll to bottom when new messages arrive or requests appear,
  // but only if the user hasn't scrolled up to read earlier content.
  useEffect(() => {
    if (scrollRef.current && isScrolledToBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, pendingUserMessages, streamingMessage, streamingToolUses, isCompacting, pendingRequestCount, activeSubagents])

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
      <div className="overflow-y-auto overscroll-contain h-full" style={{ overflowAnchor: 'none' }} ref={scrollRef} onScroll={handleScroll} data-testid="message-list" data-message-content-area>
        <div className="mx-auto w-full max-w-[720px] px-4 pb-4 pt-14 space-y-4">
        {hiddenCount > 0 && (
          <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
            {hiddenCount} earlier {hiddenCount === 1 ? 'message' : 'messages'} hidden — scroll up to load
          </div>
        )}
        {windowedMessages.map((item) => (
          <Fragment key={item.id}>
            {item.type === 'memory_recall' ? (
              <MemoryRecallItem recall={item as ApiMemoryRecall} />
            ) : item.type === 'compact_boundary' ? (
              <CompactBoundaryItem boundary={item as ApiCompactBoundary} />
            ) : (
              <>
                <MessageErrorBoundary kind="message" raw={item} itemId={item.id}>
                  <MessageItem message={item as ApiMessage} agentSlug={agentSlug} sessionId={sessionId} isSessionActive={canHaveRunningToolCalls.has(item.id)} activeSubagents={activeSubagents} completedSubagents={completedSubagents} onRemoveMessage={handleRemoveMessage} onRemoveToolCall={handleRemoveToolCall} />
                </MessageErrorBoundary>
                {turnDeliveredFiles.has(item.id) && item.id !== deferredElapsedMessageId && (
                  <DeliveredFiles files={turnDeliveredFiles.get(item.id)!} agentSlug={agentSlug} />
                )}
                {turnElapsedTimes.has(item.id) && item.id !== deferredElapsedMessageId && (
                  <div className="flex items-center gap-3 pb-1 -mt-3 text-xs text-muted-foreground tabular-nums italic">
                    <span>Worked for {formatElapsed(turnElapsedTimes.get(item.id)!)}</span>
                    <div className="h-px flex-1 bg-border" />
                    {hasVoiceConfigured && (item as ApiMessage).type === 'assistant' && item.id === lastAssistantElapsedId && (
                      <button
                        type="button"
                        onClick={handleProvideFeedback}
                        className="flex items-center gap-1 not-italic text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <MessageSquarePlus className="h-3 w-3" />
                        <span>Voice feedback</span>
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </Fragment>
        ))}

        {/* Turn-starting ghosts (sent while idle) — the next turn belongs to
            them, so they render before any streaming content. Queued ghosts
            (sent mid-turn) render at the bottom instead, below the current
            turn's streaming output and running tools. */}
        {visiblePeerMessages.filter((p) => !p.queued).map(renderPeerGhost)}
        {pendingUserMessages?.filter((p) => !p.queued).map(renderPendingGhost)}

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
                  <ToolCallItem toolCall={syntheticToolCall} agentSlug={agentSlug} isSessionActive={isActive} />
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

        {/* Deferred delivered files + elapsed time — shown after streaming content */}
        {deferredElapsedMessageId && turnDeliveredFiles.has(deferredElapsedMessageId) && (
          <DeliveredFiles files={turnDeliveredFiles.get(deferredElapsedMessageId)!} agentSlug={agentSlug} />
        )}
        {deferredElapsedMessageId && turnElapsedTimes.has(deferredElapsedMessageId) && (
          <div className="flex items-center gap-3 pb-1 -mt-3 text-xs text-muted-foreground tabular-nums italic">
            <span>Worked for {formatElapsed(turnElapsedTimes.get(deferredElapsedMessageId)!)}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
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
      </div>
      {showScrollToBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium shadow-lg hover:bg-primary/90 transition-opacity cursor-pointer"
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
