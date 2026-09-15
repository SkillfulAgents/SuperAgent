import { useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronDown, HelpCircle } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'

export interface StaleSessionNoticeProps {
  onIgnore: () => void
  onContinueCompacted: () => void
  onStartFresh: () => void
  isPending?: boolean
  /** Holds the column's scroll while the menu or help tooltip is open. */
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
  disabled,
  testId,
}: {
  title: string
  description: string
  onSelect: () => void
  disabled: boolean
  testId: string
}) {
  const id = useId()
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      disabled={disabled}
      textValue={title}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      data-testid={testId}
      className="w-full flex-col items-start gap-0.5"
    >
      <span id={`${id}-title`}>{title}</span>
      <span id={`${id}-description`} className="w-full truncate text-xs text-muted-foreground">{description}</span>
    </DropdownMenuItem>
  )
}

/** Non-blocking prompt shown above the composer for an old, large conversation. */
export function StaleSessionNotice({
  onIgnore,
  onContinueCompacted,
  onStartFresh,
  isPending = false,
  onPopoverOpenChange,
}: StaleSessionNoticeProps) {
  const [learnMoreOpen, setLearnMoreOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const anyOpen = learnMoreOpen || optionsOpen

  useEffect(() => {
    onPopoverOpenChange?.(anyOpen)
    return () => onPopoverOpenChange?.(false)
  }, [anyOpen, onPopoverOpenChange])

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
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onIgnore}
            disabled={isPending}
            data-testid="stale-toast-ignore"
          >
            Dismiss
          </Button>
          <DropdownMenu open={optionsOpen} onOpenChange={setOptionsOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                loading={isPending}
                disabled={isPending}
                aria-busy={isPending}
                aria-label={isPending ? 'Starting new conversation' : undefined}
                data-testid="stale-options-trigger"
              >
                New conversation
                {!isPending && <ChevronDown className="ml-1 h-3.5 w-3.5" aria-hidden="true" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="end"
              className="w-96"
              data-testid="stale-options-popover"
            >
              <OptionRow
                title="Start with a summary"
                description="Condenses this conversation's history and picks up there."
                onSelect={onContinueCompacted}
                disabled={isPending}
                testId="stale-summarize-continue"
              />
              <OptionRow
                title="Start totally fresh"
                description="Nothing carries over except your unsent message."
                onSelect={onStartFresh}
                disabled={isPending}
                testId="stale-new-chat"
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}
