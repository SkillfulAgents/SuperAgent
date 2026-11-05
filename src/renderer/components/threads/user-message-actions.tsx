import { ChevronRight, Split, Loader2, MessageCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'
import type { ApiMessage } from '@shared/lib/types/api'
import type { ThreadSummary } from '@shared/lib/session-threads/thread-schema'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useOptionalThread } from '@renderer/context/thread-context'
import { useThreadSummaries } from '@renderer/hooks/use-session-threads'
import { useForkSession } from '@renderer/hooks/use-sessions'
import { formatShortAgo } from '@renderer/lib/message-time'
import { CUTOUT_BEFORE_FACE, MEMBER_FACE_OVERLAP_CLASS, MEMBER_FACE_SIZE } from '@renderer/components/agents/sidebar-member-indicator'

interface UserMessageActionsProps {
  message: ApiMessage
  agentSlug: string
  sessionId: string
  /** A turn is running: a fork waits for it to finish. */
  isSessionActive?: boolean
}

const ICON_BUTTON_CLASS = cn(
  'flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors',
  'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
  'disabled:pointer-events-none disabled:opacity-50',
)

/**
 * Under a person's message in a session: its thread's repliers and count once
 * it has replies, then icons on hover: reply in thread (until the thread has
 * replies, when the count opens it) and fork the conversation from here, each
 * named by a quick tooltip. Interactive session views only (they hold the
 * ThreadProvider); people who can only view get the thread count alone.
 */
export function UserMessageActions({ message, agentSlug, sessionId, isSessionActive = false }: UserMessageActionsProps) {
  const thread = useOptionalThread()
  const summary = useThreadSummaries(agentSlug, sessionId).get(message.id)
  const fork = useForkSession()
  if (!thread) return null
  const isOpen = thread.isOpen && thread.parent?.id === message.id
  // A thread hangs off a message a teammate wrote: the host attributes those (auth mode).
  const canThread = !!message.sender
  const forking = fork.isPending && fork.variables?.fromMessageId === message.id

  return (
    <div className="flex items-center">
      {summary && <ThreadSummaryButton summary={summary} isOpen={isOpen} onOpen={() => thread.openThread(message)} />}
      {thread.canReply && (
        // Takes no room at rest, so the row sits flush with the bubble; on hover
        // (or focus) it slides in from the right and moves the row over.
        <span
          className={cn(
            'flex items-center gap-0.5 overflow-hidden transition-all duration-200',
            isOpen || forking
              ? 'ml-0.5 max-w-16 opacity-100'
              : 'max-w-0 opacity-0 focus-within:ml-0.5 focus-within:max-w-16 focus-within:opacity-100 group-hover/message:ml-0.5 group-hover/message:max-w-16 group-hover/message:opacity-100',
          )}
        >
          {/* With replies, the count already opens the thread. */}
          <TooltipProvider delayDuration={ICON_TOOLTIP_DELAY_MS}>
            {canThread && !summary && (
              <IconAction label="Reply in thread" onClick={() => thread.openThread(message)} testId="reply-in-thread" opensThread>
                <MessageCircle className="h-3.5 w-3.5" aria-hidden />
              </IconAction>
            )}
            <IconAction
              label="Fork conversation from here"
              tooltip={isSessionActive ? 'Fork once the agent has finished' : undefined}
              onClick={() => fork.mutate({ sessionId, agentSlug, fromMessageId: message.id })}
              disabled={isSessionActive || fork.isPending}
              testId="fork-from-message"
            >
              {forking ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Split className="h-3.5 w-3.5" aria-hidden />}
            </IconAction>
          </TooltipProvider>
        </span>
      )}
    </div>
  )
}

/** The icons under a message name themselves almost at once on hover. */
const ICON_TOOLTIP_DELAY_MS = 50

/**
 * An icon under a message, named by a tooltip. The trigger is a span so a
 * disabled icon still says why (a disabled button gets no pointer events).
 */
function IconAction({ label, tooltip = label, onClick, disabled = false, testId, opensThread = false, children }: {
  label: string
  tooltip?: string
  onClick: () => void
  disabled?: boolean
  testId: string
  /** Kept clear of the thread drawer's click-outside close: it opens a thread. */
  opensThread?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={ICON_BUTTON_CLASS}
            aria-label={label}
            data-testid={testId}
            {...(opensThread ? { 'data-opens-thread': '' } : {})}
          >
            {children}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/** The thread's latest repliers and reply count, with when the last came on hover. Opens the thread. */
function ThreadSummaryButton({ summary, isOpen, onOpen }: { summary: ThreadSummary; isOpen: boolean; onOpen: () => void }) {
  const count = `${summary.replyCount} ${summary.replyCount === 1 ? 'reply' : 'replies'}`
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group/thread flex max-w-full items-center rounded-md px-1.5 py-0.5 text-xs transition-colors',
        'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
        isOpen && 'bg-muted',
      )}
      data-testid="thread-summary"
      data-opens-thread=""
    >
      {/* Stacked as the sidebar stacks an agent's members. */}
      <span className="mr-1.5 flex items-center">
        {summary.repliers.map((person, index) => (
          <UserAvatar
            key={person.id}
            user={person}
            size={MEMBER_FACE_SIZE}
            className={cn(MEMBER_FACE_OVERLAP_CLASS, index < summary.repliers.length - 1 && CUTOUT_BEFORE_FACE)}
          />
        ))}
      </span>
      {/* Styled as the sender name above the bubble. */}
      <span className="text-muted-foreground">{count}</span>
      {/* When the last reply came, and a chevron, only on hover or focus. The
          row is right-aligned, so it widens to the left: the text slides in. */}
      <span
        className={cn(
          'max-w-0 overflow-hidden whitespace-nowrap text-muted-foreground opacity-0 transition-all duration-200',
          'group-hover/thread:ml-2 group-hover/thread:max-w-[14rem] group-hover/thread:opacity-100',
          'group-focus-visible/thread:ml-2 group-focus-visible/thread:max-w-[14rem] group-focus-visible/thread:opacity-100',
        )}
      >
        Last reply {formatShortAgo(new Date(summary.lastReplyAt))}
      </span>
      <ChevronRight
        className={cn(
          'h-3.5 w-0 shrink-0 text-muted-foreground opacity-0 transition-all duration-200',
          'group-hover/thread:ml-1 group-hover/thread:w-3.5 group-hover/thread:opacity-100',
          'group-focus-visible/thread:ml-1 group-focus-visible/thread:w-3.5 group-focus-visible/thread:opacity-100',
        )}
        aria-hidden
      />
    </button>
  )
}
