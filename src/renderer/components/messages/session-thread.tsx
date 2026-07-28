import { type ReactNode } from 'react'
import { MessageList } from '@renderer/components/messages/message-list'
import { AgentActivityIndicator } from '@renderer/components/messages/agent-activity-indicator'
import { TrayManager } from '@renderer/components/tray/tray-manager'
import type { PendingMessage } from '@renderer/components/messages/pending-message'

interface SessionThreadProps {
  sessionId: string
  agentSlug: string
  /** Footer pinned below the scrollable message list (input bar, read-only notice, etc.) */
  footer: ReactNode
  /** Classes for the footer wrapper — callers set their own max-width/background. */
  footerClassName?: string
  /** Whether the browser tray tab is available (interactive session view only). */
  browserActive?: boolean
  /** Read-only mirror (chat-integration replay): suppress message edit/delete actions. */
  readOnly?: boolean
  // MessageList passthrough — supplied by the interactive session view, omitted when read-only.
  pendingUserMessages?: PendingMessage[]
  pendingRequestCount?: number
  onPendingMessageAppeared?: (localId: string) => void
  suppressScrollToBottom?: boolean
}

/**
 * Shared session thread shell: a scrollable message list with a pinned footer,
 * laid out beside the file-preview / browser side tray.
 *
 * Both the interactive session column and the read-only chat-integration view
 * render this so file pills (which call useFilePreview) and the preview tray
 * always sit together under the same FilePreviewProvider, which each caller
 * supplies above this component.
 */
export function SessionThread({
  sessionId,
  agentSlug,
  footer,
  footerClassName = 'bg-background',
  browserActive = false,
  readOnly,
  pendingUserMessages,
  pendingRequestCount,
  onPendingMessageAppeared,
  suppressScrollToBottom,
}: SessionThreadProps) {
  return (
    <div
      className="file-preview-container relative flex flex-1 min-h-0 min-w-0"
      data-testid="file-preview-container"
    >
      {/* Chat column — grid pins the footer at the bottom. The transcript's floor
          is a row minimum, so no amount of footer content can take the history;
          the footer row is capped by what's left and gives way from the inside. */}
      <div
        className="flex-1 min-w-0 grid grid-rows-[minmax(160px,1fr)_minmax(0,auto)] min-h-0"
        data-testid="session-thread-main"
      >
        <MessageList
          key={sessionId}
          sessionId={sessionId}
          agentSlug={agentSlug}
          readOnly={readOnly}
          pendingUserMessages={pendingUserMessages}
          pendingRequestCount={pendingRequestCount}
          onPendingMessageAppeared={onPendingMessageAppeared}
          suppressScrollToBottom={suppressScrollToBottom}
        />
        <div
          className={`${footerClassName} pb-[env(safe-area-inset-bottom)] flex min-h-0 flex-col`}
          data-composer-footer
        >
          {/* The activity card is the only part that gives way; it scrolls inside itself. */}
          <AgentActivityIndicator sessionId={sessionId} agentSlug={agentSlug} />
          <div className="shrink-0">{footer}</div>
        </div>
      </div>
      {/* Side tray (browser, file preview) */}
      <TrayManager agentSlug={agentSlug} sessionId={sessionId} browserActive={browserActive} />
    </div>
  )
}
