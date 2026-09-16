import { ArrowRightLeft, ChevronRight } from 'lucide-react'
import { parseConnectionReplacementMessage } from '@shared/lib/utils/connection-replacement-message'
import type { UserMessageKindSpec, UserMessageRenderProps } from './types'

export function ConnectionReplacementNotice({ text, message }: UserMessageRenderProps) {
  const replacement = parseConnectionReplacementMessage(text)
  if (!replacement) return null
  const reference = replacement.kind === 'connected-accounts' ? 'account' : 'MCP'
  return (
    <div
      className="my-6 rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm"
      data-testid="connection-replacement-notice"
      data-turn-anchor-id={message.id}
    >
      <div className="flex items-start gap-3">
        <ArrowRightLeft className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground break-words">{replacement.name} connection replaced</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Session interrupted. Agent notified to update its scripts and continue with the new connection.
          </p>
          <details className="group mt-2">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" aria-hidden />
              Connection details
            </summary>
            <dl className="mt-2 space-y-2 text-xs">
              <div>
                <dt className="text-muted-foreground">Previous {reference} ID</dt>
                <dd className="mt-0.5"><code className="break-all text-foreground">{replacement.previousId}</code></dd>
              </div>
              <div>
                <dt className="text-muted-foreground">New {reference} ID</dt>
                <dd className="mt-0.5"><code className="break-all text-foreground">{replacement.replacementId}</code></dd>
              </div>
            </dl>
          </details>
        </div>
      </div>
    </div>
  )
}

export const connectionReplacementNotice: UserMessageKindSpec = {
  kind: 'connection-replacement',
  match: (text) => parseConnectionReplacementMessage(text) !== null,
  hidden: false,
  Render: ConnectionReplacementNotice,
  chrome: 'row',
}
