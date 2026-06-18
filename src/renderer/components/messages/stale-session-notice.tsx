import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'

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

// Both popovers open above the bar with the same gap and the same height, so they
// read as a matched pair regardless of which side they're anchored to.
const POPOVER_HEIGHT = 'min-h-[150px]'

/** Action row mirroring composer-options-popover's OptionRow, but a right-chevron
 *  replaces the checkmark: these are forward actions, not a current-selection. The
 *  chevron only surfaces on hover/focus, matching the spec's hovered-row treatment. */
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
      className="group flex w-full items-center justify-between gap-2 rounded-md px-3 py-2.5 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="flex flex-col">
        <span className="text-sm font-medium leading-none">{label}</span>
        <span className="mt-1.5 text-xs font-normal text-muted-foreground">{blurb}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 self-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  )
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
      <div className="flex flex-col gap-0.5">
        {/* Start with Summary — slow + fallible, so the row stays in place and
            swaps to a spinner while the summary runs. */}
        {isSummarizing ? (
          <div
            className="flex items-center gap-2 px-3 py-2.5 text-sm"
            role="status"
            data-testid="stale-new-chat-summarizing"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            <span>Summarizing this conversation...</span>
          </div>
        ) : (
          <ActionRow
            label="Start with Summary"
            blurb="Keeps the context. Drops the cost."
            onClick={onStartSummary}
            disabled={false}
            testId="stale-new-chat-summary"
          />
        )}

        {/* Start fresh — instant: closes the popover and navigates to the new chat.
            Disabled while a summary is mid-flight so it can't jump away underneath it. */}
        <ActionRow
          label="Start fresh"
          blurb="Clean slate for something new."
          onClick={() => {
            onClose()
            onStartFresh()
          }}
          disabled={isSummarizing}
          testId="stale-new-chat-fresh"
        />
      </div>

      {summaryError && (
        <div className="mt-2 px-3">
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
    <p className="text-xs text-muted-foreground">
      <span className="font-semibold text-foreground">{lead}</span> {children}
    </p>
  )
}

/**
 * Ambient, non-blocking toast shown in the footer when a returning user lands on
 * an idle + large conversation, at rest. Educate-first, deliberately qualitative
 * (no token/dollar figures). Ignore hides it locally; a plain send clears it as
 * the idle gate resets.
 *
 * Layout (per spec): a single row — title + description stacked on the left with a
 * generous gap before the Ignore / New chat buttons, which sit vertically centered
 * on the right.
 *
 * Both popovers anchor to the bar (not their trigger) so they open cleanly above
 * the whole bar with a small gap and matched height: New chat right-aligned, Learn
 * more left-aligned. Radix binds a PopoverTrigger to its nearest root, so only one
 * root can own an in-bar trigger — New chat keeps the real trigger while Learn more
 * is driven as a controlled popover from a plain link.
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

  return (
    <div data-testid="stale-toast" className="mx-auto mb-2 w-full max-w-[740px] px-4">
      {/* Outer root: Learn more. Its anchor wraps the bar so the popover opens above
          it, left-aligned. The wrapper adds no box of its own. */}
      <Popover open={learnOpen} onOpenChange={setLearnOpen}>
        <PopoverAnchor asChild>
          <div>
            {/* Inner root: New chat, anchored to the bar itself (right-aligned). */}
            <Popover open={newChatOpen} onOpenChange={setNewChatOpen}>
              <PopoverAnchor asChild>
                <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/50 p-4">
                  <div className="flex min-w-0 max-w-[60%] flex-col gap-1.5">
                    <p className="text-base font-semibold">Continue this conversation here?</p>
                    <p className="text-xs text-muted-foreground">
                      This conversation is getting pretty long. It may be cheaper, faster, and more effective to
                      start a new conversation.{' '}
                      <button
                        type="button"
                        data-testid="stale-learn-more-trigger"
                        aria-haspopup="dialog"
                        aria-expanded={learnOpen}
                        onClick={() => setLearnOpen((o) => !o)}
                        className="text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80"
                      >
                        Learn more
                      </button>
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
                    <PopoverTrigger asChild>
                      <Button type="button" size="sm" className="gap-1.5" data-testid="stale-new-chat-trigger">
                        New conversation
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                    </PopoverTrigger>
                  </div>
                </div>
              </PopoverAnchor>
              <PopoverContent
                side="top"
                align="end"
                sideOffset={8}
                className={`flex w-80 flex-col justify-center rounded-lg p-1.5 ${POPOVER_HEIGHT}`}
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
        </PopoverAnchor>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className={`flex w-80 flex-col justify-center gap-1.5 rounded-lg px-3 py-2 ${POPOVER_HEIGHT}`}
          data-testid="stale-learn-more-popover"
        >
          <p className="text-sm font-medium">Why start a new conversation?</p>
          <TeachingPoint lead="Agents can have many conversations.">
            Start a new one for each new task. They all stay under the same agent.
          </TeachingPoint>
          <TeachingPoint lead="Long conversations get heavy.">
            The longer a conversation runs, the more the agent re-reads every time you send, so it gets slower, costs more,
            and answers less sharply. A fresh conversation resets that.
          </TeachingPoint>
        </PopoverContent>
      </Popover>
    </div>
  )
}
