import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'

export interface StaleSessionNoticeProps {
  onIgnore: () => void
  onContinueCompacted: () => void
  onStartFresh: () => void
  onLearnMoreOpenChange?: (open: boolean) => void
}

function TeachingPoint({ lead, children }: { lead: string; children: ReactNode }) {
  return (
    <div className="text-xs">
      <p className="font-medium text-foreground">{lead}</p>
      <p className="text-muted-foreground">{children}</p>
    </div>
  )
}

/** Non-blocking prompt shown above the composer for an old, large conversation. */
export function StaleSessionNotice({
  onIgnore,
  onContinueCompacted,
  onStartFresh,
  onLearnMoreOpenChange,
}: StaleSessionNoticeProps) {
  const [learnMoreOpen, setLearnMoreOpen] = useState(false)

  useEffect(() => {
    onLearnMoreOpenChange?.(learnMoreOpen)
    return () => onLearnMoreOpenChange?.(false)
  }, [learnMoreOpen, onLearnMoreOpenChange])

  return (
    <div data-testid="stale-toast" className="mx-auto mb-2 w-full max-w-[740px] px-4">
      <div
        className="relative flex items-center justify-between gap-4 rounded-2xl border bg-card p-4"
        data-testid="stale-toast-card"
      >
        <div className="flex min-w-0 max-w-[60%] flex-col gap-1.5">
          <p className="text-sm font-medium">Start a new conversation?</p>
          <p className="text-xs text-muted-foreground">
            This conversation is getting pretty long. It may be cheaper, faster, and more effective to
            start a new conversation.{' '}
            <Popover open={learnMoreOpen} onOpenChange={setLearnMoreOpen}>
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
                onOpenAutoFocus={(event) => event.preventDefault()}
                onCloseAutoFocus={(event) => event.preventDefault()}
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
                <TeachingPoint lead="Summarize &amp; continue keeps the thread, not the bulk.">
                  Copies this conversation, condenses the history, and picks up there. The original
                  stays as it is.
                </TeachingPoint>
              </PopoverContent>
            </Popover>
          </p>
        </div>
        {/* Dismiss is an icon in the corner, not a button in the row — same shape as
            the install banner, which leaves the row for the two real choices. */}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onIgnore}
          data-testid="stale-toast-ignore"
          className="absolute right-2 top-2 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
        {/* pr-7 keeps the buttons clear of the dismiss icon above them. */}
        <div className="flex shrink-0 items-center gap-2 pr-7">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onContinueCompacted}
            data-testid="stale-summarize-continue"
          >
            Summarize &amp; continue
          </Button>
          <Button type="button" size="sm" onClick={onStartFresh} data-testid="stale-new-chat">
            New conversation
          </Button>
        </div>
      </div>
    </div>
  )
}
