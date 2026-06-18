import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'

export interface StaleSessionToastProps {
  /** Local hide (no persistence). */
  onIgnore: () => void
  /** Branch to a fresh chat carrying an AI summary + the current draft. */
  onStartSummary: () => void
  /** Fresh chat carrying only the current draft. */
  onStartFresh: () => void
  /** Summary action in flight (slow, fallible). Keeps the popover open with a spinner. */
  isSummarizing: boolean
  /** Set when the last summary attempt failed; renders an inline error + Retry. */
  summaryError: string | null
  /** Re-attempt the summary (same handler as onStartSummary, surfaced on failure). */
  onRetrySummary: () => void
  /** Fresh-chat action in flight (near-instant; just disables the rows). */
  isStartingFresh: boolean
}

/** Action row mirroring composer-options-popover's OptionRow, but a right-chevron
 *  replaces the checkmark: these are forward actions, not a current-selection. */
function ActionRow({
  label,
  blurb,
  onClick,
  disabled,
  testId,
}: {
  label: string
  blurb: string
  onClick: () => void
  disabled: boolean
  testId: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="flex flex-col">
        <span className="text-sm font-medium leading-none">{label}</span>
        <span className="mt-1 text-xs font-normal text-muted-foreground">{blurb}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 self-center text-muted-foreground" />
    </button>
  )
}

/** Choice surface anchored to the "New chat" button. Opens up and to the right.
 *  Start fresh closes and navigates; Start with Summary keeps the popover open
 *  with a spinner, then surfaces an inline error + retry on failure. */
function NewChatPopover({
  onStartSummary,
  onStartFresh,
  isSummarizing,
  summaryError,
  onRetrySummary,
  isStartingFresh,
}: Pick<
  StaleSessionToastProps,
  'onStartSummary' | 'onStartFresh' | 'isSummarizing' | 'summaryError' | 'onRetrySummary' | 'isStartingFresh'
>) {
  const [open, setOpen] = useState(false)
  const busy = isSummarizing || isStartingFresh

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          data-testid="stale-new-chat-trigger"
        >
          New chat
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 px-1 py-2" data-testid="stale-new-chat-popover">
        <div className="flex flex-col gap-1">
          {/* Start with Summary — slow + fallible, so the row stays in place and
              swaps to a spinner while the summary runs. */}
          {isSummarizing ? (
            <div
              className="flex items-center gap-2 px-2 py-1.5 text-sm"
              role="status"
              data-testid="stale-new-chat-summarizing"
            >
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              <span>Summarizing this chat...</span>
            </div>
          ) : (
            <ActionRow
              label="Start with Summary"
              blurb="Keeps the context. Drops the cost."
              onClick={onStartSummary}
              disabled={isStartingFresh}
              testId="stale-new-chat-summary"
            />
          )}

          {/* Start fresh — near-instant, so it closes the popover before navigating. */}
          <ActionRow
            label="Start fresh"
            blurb="Clean slate for something new."
            onClick={() => {
              setOpen(false)
              onStartFresh()
            }}
            disabled={busy}
            testId="stale-new-chat-fresh"
          />
        </div>

        {summaryError && (
          <div className="mt-2 px-2">
            <p className="text-xs text-destructive">{summaryError}</p>
            <button
              type="button"
              onClick={onRetrySummary}
              data-testid="stale-new-chat-retry"
              className="mt-1 text-xs font-medium text-primary hover:underline"
            >
              Retry
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function TeachingPoint({ lead, children }: { lead: string; children: ReactNode }) {
  return (
    <p className="text-xs text-muted-foreground">
      <span className="font-semibold text-foreground">{lead}</span> {children}
    </p>
  )
}

/** Education surface anchored to the inline "Learn more" link. Opens up and to
 *  the left (opposite end from the New chat popover). Purely informational. */
function LearnMorePopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="stale-learn-more-trigger"
          className="text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80"
        >
          Learn more
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 space-y-2" data-testid="stale-learn-more-popover">
        <p className="text-sm font-medium">Why start a new chat?</p>
        <TeachingPoint lead="Agents can have many chats.">
          Start a new one for each new topic. They all stay under the same agent.
        </TeachingPoint>
        <TeachingPoint lead="Long chats get heavy.">
          The longer a chat runs, the more the agent re-reads every time you send, so it gets slower, costs more,
          and answers less sharply. A fresh chat resets that.
        </TeachingPoint>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Ambient, non-blocking toast shown in the footer when a returning user lands on
 * an idle + large conversation, at rest. Educate-first, deliberately qualitative
 * (no token/dollar figures). Ignore hides it locally; a plain send clears it as
 * the idle gate resets. The two forward actions live in the New chat popover; the
 * education lives in the Learn more popover.
 */
export function StaleSessionToast({
  onIgnore,
  onStartSummary,
  onStartFresh,
  isSummarizing,
  summaryError,
  onRetrySummary,
  isStartingFresh,
}: StaleSessionToastProps) {
  return (
    <div data-testid="stale-toast" className="mx-auto mb-2 w-full max-w-[740px] px-4">
      <div className="rounded-lg border bg-muted/50 p-3">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium">Continue chatting here?</p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onIgnore}
              data-testid="stale-toast-ignore"
            >
              Ignore
            </Button>
            <NewChatPopover
              onStartSummary={onStartSummary}
              onStartFresh={onStartFresh}
              isSummarizing={isSummarizing}
              summaryError={summaryError}
              onRetrySummary={onRetrySummary}
              isStartingFresh={isStartingFresh}
            />
          </div>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          This conversation is getting pretty long. It may be cheaper, faster, and more effective to start a new
          conversation. <LearnMorePopover />
        </p>
      </div>
    </div>
  )
}
