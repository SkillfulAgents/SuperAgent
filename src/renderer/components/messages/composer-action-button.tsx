import { ArrowUp, Loader2, Square } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'

interface ComposerActionButtonProps {
  isActive: boolean
  isWaitingBackground: boolean
  /** User-entered composer content (restored drafts and a wordless live recording don't count). */
  hasContent: boolean
  /** Whether a send right now would queue behind the running turn. Derived once by the container so the label can't diverge from the actual send semantics. */
  willQueue: boolean
  canSubmit: boolean
  isSending: boolean
  isInterrupting: boolean
  onInterrupt: () => void
}

export function ComposerActionButton({
  isActive,
  isWaitingBackground,
  hasContent,
  willQueue,
  canSubmit,
  isSending,
  isInterrupting,
  onInterrupt,
}: ComposerActionButtonProps) {
  // While the agent works (or background tasks linger) this slot is Stop with
  // an empty composer and Send once the user has typed. It is always a SINGLE
  // element whose props vary — two elements in separate branches would drop
  // keyboard focus to <body> on every swap. Mode precedence:
  //   1. An in-flight interrupt pins Stop (disabled + spinner) so typing can't
  //      hide the only feedback that the interrupt is still running.
  //   2. An in-flight send pins Send (disabled + spinner) — submit clears the
  //      composer, and swapping to an enabled Stop under the pointer would turn
  //      a double-click into an interrupt of the just-queued turn.
  //   3. Otherwise content decides: Send when present, Stop when empty.
  const busy = isActive || isWaitingBackground
  const stopMode = busy && (isInterrupting || (!isSending && !hasContent))

  const stopLabel = isWaitingBackground ? 'Stop background processes' : 'Stop the agent'
  const sendLabel = willQueue ? 'Queue message' : 'Send message'
  const label = stopMode ? stopLabel : sendLabel

  // isSending also disables stop mode: it covers the one-frame race where a
  // submit has cleared the composer but the mutation's pending flag hasn't
  // rendered yet — the node must never be an enabled Stop right after a Send
  // click.
  return (
    <Button
      type={stopMode ? 'button' : 'submit'}
      size="icon"
      variant={stopMode ? 'outline' : 'default'}
      className="h-[34px] w-[34px]"
      onClick={stopMode ? onInterrupt : undefined}
      disabled={stopMode ? isInterrupting || isSending : !canSubmit || isSending}
      aria-label={label}
      title={label}
      data-testid={stopMode ? 'stop-button' : 'send-button'}
    >
      {isInterrupting || isSending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : stopMode ? (
        <Square className="h-3.5 w-3.5 fill-current" />
      ) : (
        <ArrowUp className="h-4 w-4" />
      )}
    </Button>
  )
}
