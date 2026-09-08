import type { ReactNode } from 'react'
import { ArrowUp, Loader2, Square } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'

interface ComposerActionButtonProps {
  isActive: boolean
  isWaitingBackground: boolean
  canSubmit: boolean
  isSending: boolean
  isInterrupting: boolean
  onInterrupt: () => void
  /**
   * Rendered in place of Send. The composer hands this slot to voice mode
   * while there is nothing to send yet, so an empty composer leads with one
   * live action instead of a disabled arrow.
   */
  primary?: ReactNode
}

export function ComposerActionButton({
  isActive,
  isWaitingBackground,
  canSubmit,
  isSending,
  isInterrupting,
  onInterrupt,
  primary,
}: ComposerActionButtonProps) {
  // While the agent works (or background tasks linger) show Stop alongside
  // Send — messages sent mid-turn are queued and picked up by the agent loop.
  const inTurn = isActive || isWaitingBackground
  const sendLabel = inTurn && !isWaitingBackground ? 'Queue message' : 'Send message'
  const send = primary ?? (
    <Button
      type="submit"
      size="icon"
      className="h-[34px] w-[34px]"
      disabled={!canSubmit || isSending}
      aria-label={sendLabel}
      title={sendLabel}
      data-testid="send-button"
    >
      {isSending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <ArrowUp className="h-4 w-4" />
      )}
    </Button>
  )

  if (!inTurn) return <>{send}</>

  const stopLabel = isWaitingBackground ? 'Stop background processes' : 'Stop the agent'
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="h-[34px] w-[34px]"
        onClick={onInterrupt}
        disabled={isInterrupting}
        aria-label={stopLabel}
        title={stopLabel}
        data-testid="stop-button"
      >
        {isInterrupting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Square className="h-3.5 w-3.5 fill-current" />
        )}
      </Button>
      {send}
    </div>
  )
}
