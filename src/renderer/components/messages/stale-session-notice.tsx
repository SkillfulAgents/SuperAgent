import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { OptionRow } from './option-row'

// Forward-action affordance for the New conversation rows: a right-chevron in place
// of the model picker's selection check, always visible so each row reads as actionable.
const FORWARD_CHEVRON = (
  <ChevronRight className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />
)

export interface StaleSessionToastProps {
  /** Local hide (no persistence). */
  onIgnore: () => void
  /** Branch to a fresh chat carrying an AI summary + the current draft. */
  onStartSummary: () => void
  /** Snapshot the composer into the new chat and navigate there. Instant (no session
   *  is created until the user sends), so the row just closes the popover and leaves. */
  onStartFresh: () => void
  /** Summary action in flight (slow, fallible). Keeps the popover open with a spinner. */
  isSummarizing: boolean
  /** Set when the last summary attempt failed; renders an inline error + Retry. */
  summaryError: string | null
  /** Re-attempt the summary (same handler as onStartSummary, surfaced on failure). */
  onRetrySummary: () => void
  /** Fires when either popover opens or closes, so the parent can hide UI it
   *  overlaps (the centered scroll-to-bottom FAB). */
  onMenuOpenChange?: (open: boolean) => void
}

/** The forward-action rows rendered inside the New chat popover. Start fresh closes
 *  and navigates; Start with Summary keeps the popover open with a spinner, then
 *  surfaces an inline error + retry on failure. */
function NewChatActions({
  onStartSummary,
  onStartFresh,
  isSummarizing,
  summaryError,
  onRetrySummary,
  onClose,
}: Pick<
  StaleSessionToastProps,
  'onStartSummary' | 'onStartFresh' | 'isSummarizing' | 'summaryError' | 'onRetrySummary'
> & { onClose: () => void }) {
  return (
    <>
      <div className="flex flex-col gap-1">
        {/* Start with Summary — slow + fallible, so the row stays in place and
            swaps to a spinner while the summary runs. */}
        {isSummarizing ? (
          <div
            className="flex items-center gap-2 px-2 py-1 text-xs"
            role="status"
            data-testid="stale-new-chat-summarizing"
          >
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            <span>Summarizing this conversation...</span>
          </div>
        ) : (
          <OptionRow
            label="Start with Summary"
            blurb="Keeps the context. Drops the cost."
            onClick={onStartSummary}
            testId="stale-new-chat-summary"
            alwaysShowBlurb
            trailing={FORWARD_CHEVRON}
          />
        )}

        {/* Start fresh — instant: closes the popover and navigates to the new chat.
            Disabled while a summary is mid-flight so it can't jump away underneath it. */}
        <OptionRow
          label="Start fresh"
          blurb="Clean slate for something new."
          onClick={() => {
            onClose()
            onStartFresh()
          }}
          disabled={isSummarizing}
          testId="stale-new-chat-fresh"
          alwaysShowBlurb
          trailing={FORWARD_CHEVRON}
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
    </>
  )
}

function TeachingPoint({ lead, children }: { lead: string; children: ReactNode }) {
  return (
    <div className="text-xs">
      <p className="font-semibold text-foreground">{lead}</p>
      <p className="text-muted-foreground">{children}</p>
    </div>
  )
}

/**
 * Ambient, non-blocking toast shown in the footer when a returning user lands on
 * an idle + large conversation, at rest. Educate-first, deliberately qualitative
 * (no token/dollar figures). Ignore hides it locally; a plain send clears it as
 * the idle gate resets.
 *
 * Layout (per spec): a single row — title + description stacked on the left with a
 * generous gap before the Ignore / New conversation buttons, which sit vertically
 * centered on the right.
 *
 * Each popover is its own root, anchored to its own trigger so it overlays close to
 * the button it springs from (typical popover behavior) and sizes to its content —
 * matching the composer model selector. New conversation opens above its button
 * (right-aligned); Learn more above its inline link (left-aligned).
 */
export function StaleSessionToast({
  onIgnore,
  onStartSummary,
  onStartFresh,
  isSummarizing,
  summaryError,
  onRetrySummary,
  onMenuOpenChange,
}: StaleSessionToastProps) {
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [learnOpen, setLearnOpen] = useState(false)

  // Report whether either popover is open. Cleanup resets to closed so the parent
  // never gets stuck suppressing the FAB if the toast unmounts mid-open (e.g. a
  // forward action navigates away while the menu is open).
  useEffect(() => {
    onMenuOpenChange?.(newChatOpen || learnOpen)
    return () => onMenuOpenChange?.(false)
  }, [newChatOpen, learnOpen, onMenuOpenChange])

  // -mb-1 (−4px) trims the composer's pt-3 (12px) below us down to an 8px gap.
  return (
    <div data-testid="stale-toast" className="mx-auto -mb-1 w-full max-w-[740px] px-4">
      <div className="flex items-center justify-between gap-4 rounded-2xl border bg-muted/50 p-4">
        <div className="flex min-w-0 max-w-[60%] flex-col gap-1.5">
          <p className="text-sm font-medium">Start a new conversation?</p>
          <p className="text-xs text-muted-foreground">
            This conversation is getting pretty long. It may be cheaper, faster, and more effective to
            start a new conversation.{' '}
            <Popover open={learnOpen} onOpenChange={setLearnOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-testid="stale-learn-more-trigger"
                  className="text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80"
                >
                  Learn more
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                onOpenAutoFocus={(e) => e.preventDefault()}
                onCloseAutoFocus={(e) => e.preventDefault()}
                className="flex w-80 flex-col gap-1.5 rounded-lg px-4 py-3"
                data-testid="stale-learn-more-popover"
              >
                <TeachingPoint lead="Your agent can handle many conversations at once.">
                  It works better and smarter with focused conversations. We recommend starting a new
                  conversation with your agent for each task so it isn&apos;t wasting time or tokens on
                  unrelated chat history.
                </TeachingPoint>
                <TeachingPoint lead="Agents re-read everything each time they reply.">
                  That&apos;s why long conversations slow down and get expensive. Start fresh to keep the
                  agent fast and sharp.
                </TeachingPoint>
              </PopoverContent>
            </Popover>
          </p>
        </div>
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
          <Popover open={newChatOpen} onOpenChange={setNewChatOpen}>
            <PopoverTrigger asChild>
              <Button type="button" size="sm" className="gap-1.5" data-testid="stale-new-chat-trigger">
                New conversation
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="end"
              className="w-64 px-1 py-2"
              data-testid="stale-new-chat-popover"
            >
              <NewChatActions
                onStartSummary={onStartSummary}
                onStartFresh={onStartFresh}
                isSummarizing={isSummarizing}
                summaryError={summaryError}
                onRetrySummary={onRetrySummary}
                onClose={() => setNewChatOpen(false)}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  )
}
