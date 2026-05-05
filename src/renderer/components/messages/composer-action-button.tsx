import { ArrowUp, Loader2, Square } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'

interface ComposerActionButtonProps {
  isActive: boolean
  canSubmit: boolean
  isSending: boolean
  isInterrupting: boolean
  onInterrupt: () => void
}

export function ComposerActionButton({
  isActive,
  canSubmit,
  isSending,
  isInterrupting,
  onInterrupt,
}: ComposerActionButtonProps) {
  if (isActive) {
    return (
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="h-[34px] w-[34px]"
        onClick={onInterrupt}
        disabled={isInterrupting}
        aria-label="Stop the agent"
        title="Stop the agent"
        data-testid="stop-button"
      >
        {isInterrupting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Square className="h-3.5 w-3.5 fill-current" />
        )}
      </Button>
    )
  }

  return (
    <Button
      type="submit"
      size="icon"
      className="h-[34px] w-[34px]"
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
