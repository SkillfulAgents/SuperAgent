import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'

export interface StaleSessionNoticeProps {
  onIgnore: () => void
  onStartFresh: () => void
  onLearnMoreOpenChange?: (open: boolean) => void
}

function TeachingPoint({ lead, children }: { lead: string; children: ReactNode }) {
  return (
    <div className="text-xs">
      <p className="font-semibold text-foreground">{lead}</p>
      <p className="text-muted-foreground">{children}</p>
    </div>
  )
}

/** Non-blocking prompt shown above the composer for an old, large conversation. */
export function StaleSessionNotice({
  onIgnore,
  onStartFresh,
  onLearnMoreOpenChange,
}: StaleSessionNoticeProps) {
  const [learnMoreOpen, setLearnMoreOpen] = useState(false)

  useEffect(() => {
    onLearnMoreOpenChange?.(learnMoreOpen)
    return () => onLearnMoreOpenChange?.(false)
  }, [learnMoreOpen, onLearnMoreOpenChange])

  return (
    <div data-testid="stale-toast" className="mx-auto -mb-1 w-full max-w-[740px] px-4">
      <div className="flex items-center justify-between gap-4 rounded-2xl border bg-muted/50 p-4">
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
