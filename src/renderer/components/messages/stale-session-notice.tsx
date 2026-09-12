import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, HelpCircle } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'

export interface StaleSessionNoticeProps {
  onIgnore: () => void
  onContinueCompacted: () => void
  onStartFresh: () => void
  /** Fires while any of the card's popovers is open, so the column can hold its scroll. */
  onPopoverOpenChange?: (open: boolean) => void
}

function TeachingPoint({ lead, children }: { lead: string; children: ReactNode }) {
  return (
    <div className="text-xs">
      <p className="font-medium text-foreground">{lead}</p>
      <p className="text-muted-foreground">{children}</p>
    </div>
  )
}

/** One row of the options menu: a title with a one-line description under it. */
function OptionRow({
  title,
  description,
  onSelect,
  testId,
}: {
  title: string
  description: string
  onSelect: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      data-testid={testId}
      className="flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
    >
      <span className="text-sm">{title}</span>
      <span className="w-full truncate text-xs text-muted-foreground">{description}</span>
    </button>
  )
}

/** Non-blocking prompt shown above the composer for an old, large conversation. */
export function StaleSessionNotice({
  onIgnore,
  onContinueCompacted,
  onStartFresh,
  onPopoverOpenChange,
}: StaleSessionNoticeProps) {
  const [learnMoreOpen, setLearnMoreOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const anyOpen = learnMoreOpen || optionsOpen

  useEffect(() => {
    onPopoverOpenChange?.(anyOpen)
    return () => onPopoverOpenChange?.(false)
  }, [anyOpen, onPopoverOpenChange])

  const choose = (action: () => void) => () => {
    setOptionsOpen(false)
    action()
  }

  return (
    <div data-testid="stale-toast" className="mx-auto mb-2 w-full max-w-[740px] px-4">
      <div
        className="flex items-center justify-between gap-4 rounded-2xl bg-muted/80 p-4 backdrop-blur-md"
        data-testid="stale-toast-card"
      >
        <div className="flex min-w-0 max-w-[60%] flex-col gap-0.5">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            Start a new conversation
            <TooltipProvider delayDuration={200}>
              <Tooltip open={learnMoreOpen} onOpenChange={setLearnMoreOpen}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Learn more"
                    data-testid="stale-learn-more-trigger"
                    className="inline-flex shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <HelpCircle className="h-3 w-3" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                {/* Styled like a popover rather than the dark one-line tooltip: three
                    teaching points need the light surface and two text tones. */}
                <TooltipContent
                  side="top"
                  align="start"
                  className="flex w-80 flex-col gap-1.5 rounded-lg border bg-popover px-4 py-3 text-popover-foreground shadow-md"
                  data-testid="stale-learn-more-tooltip"
                >
                  <TeachingPoint lead="Agents re-read the whole conversation every reply.">
                    Long ones get slower and cost more.
                  </TeachingPoint>
                  <TeachingPoint lead="One task per conversation works best.">
                    Your agent can run many at once, so start a new one for each task.
                  </TeachingPoint>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </p>
          <p className="text-xs text-muted-foreground">
            This conversation has gotten long — a fresh one will be faster and cheaper.
          </p>
        </div>
        {/* Dismiss stays a plain button beside the real choice; the dropdown answers
            the card's question and its popover explains the two ways. */}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onIgnore}
            data-testid="stale-toast-ignore"
          >
            Dismiss
          </Button>
          <Popover open={optionsOpen} onOpenChange={setOptionsOpen}>
            <PopoverTrigger asChild>
              <Button type="button" size="sm" data-testid="stale-options-trigger">
                New conversation
                <ChevronDown className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="end"
              role="menu"
              className="flex w-96 flex-col p-1"
              data-testid="stale-options-popover"
            >
              <OptionRow
                title="Start with a summary"
                description="Condenses this conversation's history and picks up there."
                onSelect={choose(onContinueCompacted)}
                testId="stale-summarize-continue"
              />
              <OptionRow
                title="Start totally fresh"
                description="Nothing carries over except your unsent message."
                onSelect={choose(onStartFresh)}
                testId="stale-new-chat"
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  )
}
