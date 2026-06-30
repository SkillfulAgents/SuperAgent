import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'

export interface StaleSessionToastProps {
  /** Local hide (no persistence). */
  onIgnore: () => void
  /** Snapshot the live composer into a new chat under this agent and navigate there.
   *  Instant — no session is created until the user actually sends. */
  onStartFresh: () => void
  /** Fires when the Learn more popover opens or closes, so the parent can hide UI
   *  it overlaps (the centered scroll-to-bottom FAB). */
  onMenuOpenChange?: (open: boolean) => void
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
 * centered on the right. "New conversation" starts fresh immediately (the live
 * composer carries over; no session is created until the user sends). Learn more
 * opens an educational popover above its inline link (left-aligned).
 */
export function StaleSessionToast({ onIgnore, onStartFresh, onMenuOpenChange }: StaleSessionToastProps) {
  const [learnOpen, setLearnOpen] = useState(false)

  // Report whether the Learn more popover is open. Cleanup resets to closed so the
  // parent never gets stuck suppressing the FAB if the toast unmounts mid-open.
  useEffect(() => {
    onMenuOpenChange?.(learnOpen)
    return () => onMenuOpenChange?.(false)
  }, [learnOpen, onMenuOpenChange])

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
          <Button
            type="button"
            size="sm"
            onClick={onStartFresh}
            data-testid="stale-new-chat"
          >
            New conversation
          </Button>
        </div>
      </div>
    </div>
  )
}
