import { Component, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { captureRendererException } from '@renderer/lib/error-reporting'

/** What kind of item failed to render — drives the copy and the Sentry tags. */
type RenderItemKind = 'message' | 'tool call' | 'thinking block'

interface MessageErrorBoundaryProps {
  children: ReactNode
  kind: RenderItemKind
  /** The raw payload for this item, shown verbatim under "View raw". */
  raw: unknown
  /** Stable id (message id / tool-call id) for Sentry correlation. */
  itemId?: string
}

interface MessageErrorBoundaryState {
  error: Error | null
}

/**
 * Isolates a single message or tool call so a render error in one item can't
 * crash the whole thread. On error it swaps the item for an inline notice with
 * a "View raw" escape hatch, and reports the error to Sentry.
 */
export class MessageErrorBoundary extends Component<MessageErrorBoundaryProps, MessageErrorBoundaryState> {
  state: MessageErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): MessageErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    captureRendererException(error, {
      tags: { feature: 'message-render', item_kind: this.props.kind },
      extra: {
        itemId: this.props.itemId,
        componentStack: info.componentStack,
      },
    })
  }

  render(): ReactNode {
    if (this.state.error) {
      return <RenderErrorNotice kind={this.props.kind} raw={this.props.raw} error={this.state.error} />
    }
    return this.props.children
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function RenderErrorNotice({ kind, raw, error }: { kind: RenderItemKind; raw: unknown; error: Error }) {
  const [showRaw, setShowRaw] = useState(false)
  const rawText = useMemo(() => safeStringify(raw), [raw])

  return (
    <div
      className="border border-amber-300/70 dark:border-amber-700/60 rounded-md bg-amber-50 dark:bg-amber-950/30 text-sm"
      data-testid="message-error-boundary"
    >
      <div className="flex items-center gap-2 px-3 py-2 text-amber-800 dark:text-amber-200">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="font-medium">Failed to display this {kind}</span>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="ml-auto shrink-0 text-xs underline underline-offset-2 hover:no-underline"
        >
          {showRaw ? 'Hide raw' : 'View raw'}
        </button>
      </div>
      {showRaw && (
        <div className="px-3 pb-3 space-y-2">
          {error.message && (
            <div className="text-xs text-amber-700/90 dark:text-amber-300/80 font-mono break-words">
              {error.message}
            </div>
          )}
          <pre
            className={cn(
              'bg-background/70 rounded p-2 text-xs overflow-auto max-h-64 whitespace-pre-wrap break-words'
            )}
          >
            {rawText}
          </pre>
        </div>
      )}
    </div>
  )
}
