import { ArrowUp, Loader2, Square } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'

interface ComposerActionButtonProps {
  isActive: boolean
  isWaitingBackground: boolean
  canSubmit: boolean
  isSending: boolean
  isInterrupting: boolean
  onInterrupt: () => void
}

export function ComposerActionButton({
  isActive,
  isWaitingBackground,
  canSubmit,
  isSending,
  isInterrupting,
  onInterrupt,
}: ComposerActionButtonProps) {
  // While the agent works (or background tasks linger) show Stop alongside
  // Send — messages sent mid-turn are queued and picked up by the agent loop.
  if (isActive || isWaitingBackground) {
    const stopLabel = isWaitingBackground ? 'Stop background processes' : 'Stop the agent'
    const sendLabel = isWaitingBackground ? 'Send message' : 'Queue message'
    return (
      <div className="flex items-center">
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="h-7 w-7"
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
        <Button
          type="submit"
          size="icon"
          className="ml-1.5 h-7 w-7"
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
      </div>
    )
  }

  return (
    <Button
      type="submit"
      size="icon"
      // 6px before it: the plain buttons' own 6px padding is the rest of the gap (chat-composer-box.tsx).
      className="ml-1.5 h-7 w-7"
      disabled={!canSubmit || isSending}
      aria-label="Send message"
      title="Send message"
      data-testid="send-button"
    >
      {isSending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <ArrowUp className="h-4 w-4" />
      )}
    </Button>
  )
}
