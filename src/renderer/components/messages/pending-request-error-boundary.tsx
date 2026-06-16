import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useInterruptSession, useSendMessage } from '@renderer/hooks/use-messages'
import { captureRendererException } from '@renderer/lib/error-reporting'

// Sent back to the agent when the user dismisses a request card that failed to
// render. The agent's input request is interrupted first, so this starts a
// fresh turn carrying the feedback.
const DISMISS_FEEDBACK =
  "I couldn't display your last request — the tool call arguments appear to be malformed, so it was dismissed. Please double-check the arguments against the tool's schema and try again."

interface PendingRequestErrorBoundaryProps {
  children: ReactNode
  sessionId: string
  agentSlug: string
  /** Removes the broken card from the pending list (the descriptor's onComplete). */
  onDismiss: () => void
  /** Stable id (descriptor key / tool-call id) for Sentry correlation. */
  itemId?: string
  /** The request kind, for Sentry tags. */
  kind?: string
}

interface PendingRequestErrorBoundaryState {
  error: Error | null
}

/**
 * Isolates a single pending-request card so a render error in one card can't
 * crash the whole chat view (the cards render in the composer slot, OUTSIDE the
 * per-message MessageErrorBoundary). On error it swaps the card for a notice
 * with a Dismiss action that interrupts the session and tells the agent its
 * tool call was malformed, then reports the error to Sentry.
 */
export class PendingRequestErrorBoundary extends Component<
  PendingRequestErrorBoundaryProps,
  PendingRequestErrorBoundaryState
> {
  state: PendingRequestErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): PendingRequestErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    captureRendererException(error, {
      tags: { feature: 'pending-request-render', request_kind: this.props.kind ?? 'unknown' },
      extra: {
        itemId: this.props.itemId,
        componentStack: info.componentStack,
      },
    })
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <PendingRequestErrorFallback
          sessionId={this.props.sessionId}
          agentSlug={this.props.agentSlug}
          onDismiss={this.props.onDismiss}
        />
      )
    }
    return this.props.children
  }
}

function PendingRequestErrorFallback({
  sessionId,
  agentSlug,
  onDismiss,
}: {
  sessionId: string
  agentSlug: string
  onDismiss: () => void
}) {
  const interruptSession = useInterruptSession()
  const sendMessage = useSendMessage()
  const [dismissing, setDismissing] = useState(false)

  const handleDismiss = async () => {
    if (dismissing) return
    setDismissing(true)
    try {
      // Interrupt the in-flight request (the agent is blocked awaiting input),
      // then send feedback so it can correct course on the next turn.
      await interruptSession.mutateAsync({ sessionId, agentSlug })
      await sendMessage.mutateAsync({ sessionId, agentSlug, content: DISMISS_FEEDBACK })
    } catch (err) {
      console.error('Failed to dismiss broken request card:', err)
    } finally {
      // Always clear the broken card locally, even if the network calls failed.
      onDismiss()
      setDismissing(false)
    }
  }

  return (
    <div
      className="border border-amber-300/70 dark:border-amber-700/60 rounded-[12px] bg-amber-50 dark:bg-amber-950/30 shadow-md text-sm"
      data-testid="pending-request-error-boundary"
    >
      <div className="flex items-start gap-2 p-4 text-amber-800 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium">{"This request couldn't be displayed"}</p>
          <p className="mt-1 text-xs text-amber-700/90 dark:text-amber-300/80">
            The agent sent a malformed request. Dismiss it to interrupt the agent and let it try again.
          </p>
        </div>
      </div>
      <div className="flex justify-end px-4 pb-4">
        <Button
          onClick={handleDismiss}
          loading={dismissing}
          size="xs"
          variant="outline"
          className="h-8 min-w-24"
          data-testid="pending-request-error-dismiss"
        >
          Dismiss
        </Button>
      </div>
    </div>
  )
}
