import { Loader2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
} from '@renderer/components/ui/alert-dialog'
import { estimateNextMessageCostUsd } from '@shared/lib/stale-session/message-cost'

export interface StaleSessionPromptProps {
  open: boolean
  agentName: string
  contextTokens: number
  lastActivityAt: Date | null
  model: string
  isSummarizing: boolean
  isStartingNewTopic?: boolean
  error: string | null
  /** True only when the summary/branch action itself failed — not when new-topic failed. */
  summaryFailed?: boolean
  onContinueSummary: () => void
  onNewTopic: () => void
  onSendHere: () => void
  onRetry: () => void
  onOpenChange: (open: boolean) => void
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

export function StaleSessionPrompt({
  open,
  agentName,
  contextTokens,
  lastActivityAt,
  model,
  isSummarizing,
  isStartingNewTopic = false,
  error,
  summaryFailed = false,
  onContinueSummary,
  onNewTopic,
  onSendHere,
  onRetry,
  onOpenChange,
}: StaleSessionPromptProps) {
  const cost = estimateNextMessageCostUsd({ contextTokens, model, idle: true })

  const timePart = lastActivityAt ? `, last used ${formatDistanceToNow(lastActivityAt, { addSuffix: true })}` : ''
  const costPart = cost !== null ? `, about $${cost.toFixed(2)},` : ''
  const headerText =
    `This chat is holding ~${formatTokens(contextTokens)} tokens${timePart}. ` +
    `Your next message re-reads all of it${costPart} and that repeats on every message.`

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Large context</AlertDialogTitle>
          <AlertDialogDescription>{headerText}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        <div className="grid gap-3 py-2">
          {/* Option 1: Continue from a summary (recommended) */}
          <button
            type="button"
            onClick={summaryFailed ? onRetry : onContinueSummary}
            disabled={isSummarizing && !summaryFailed}
            className="flex flex-col rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2 text-sm font-medium leading-none">
              {isSummarizing && !summaryFailed ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
                  <span>Carrying over context...</span>
                </>
              ) : (
                <>
                  <span>{summaryFailed ? 'Retry summary' : 'Continue from a summary'}</span>
                  {!summaryFailed && (
                    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-normal leading-none text-muted-foreground">
                      Recommended
                    </span>
                  )}
                </>
              )}
            </div>
            {(!isSummarizing || summaryFailed) && (
              <p className="text-xs text-muted-foreground mt-1.5">
                Fresh, fast chat. A short summary carries the thread, drops the cost.
              </p>
            )}
          </button>

          {/* Option 2: Start a new topic */}
          <button
            type="button"
            onClick={onNewTopic}
            disabled={isStartingNewTopic}
            className="flex flex-col rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <div className="text-sm font-medium leading-none">
              Start a new topic with {agentName}
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              Clean slate. Nothing carried over. Best when this is unrelated.
            </p>
          </button>

          {/* Option 3: Send here anyway (quiet) */}
          <button
            type="button"
            onClick={onSendHere}
            className="flex flex-col rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors"
          >
            <div className="text-sm font-medium leading-none text-muted-foreground">
              Send here anyway
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              We won&apos;t ask again in this one.
            </p>
          </button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
