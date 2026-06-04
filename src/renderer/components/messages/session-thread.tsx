import { type ReactNode } from 'react'
import { MessageList } from '@renderer/components/messages/message-list'
import { AgentActivityIndicator } from '@renderer/components/messages/agent-activity-indicator'
import { TrayManager } from '@renderer/components/tray/tray-manager'

interface PendingMessage {
  text: string
  sentAt: number
  sender?: { id: string; name: string; email: string }
}

interface SessionThreadProps {
  sessionId: string
  agentSlug: string
  /** Footer pinned below the scrollable message list (input bar, read-only notice, etc.) */
  footer: ReactNode
  /** Classes for the footer wrapper — callers set their own max-width/background. */
  footerClassName?: string
  /** Whether the browser tray tab is available (interactive session view only). */
  browserActive?: boolean
  // MessageList passthrough — supplied by the interactive session view, omitted when read-only.
  pendingUserMessage?: PendingMessage | null
  pendingRequestCount?: number
  onPendingMessageAppeared?: () => void
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
  pendingUserMessage,
  pendingRequestCount,
  onPendingMessageAppeared,
}: SessionThreadProps) {
  return (
    <div className="relative flex-1 flex min-h-0">
      {/* Chat column — grid pins the footer at the bottom */}
      <div className="flex-1 min-w-0 grid grid-rows-[1fr_auto] min-h-0">
        <MessageList
          key={sessionId}
          sessionId={sessionId}
          agentSlug={agentSlug}
          pendingUserMessage={pendingUserMessage}
          pendingRequestCount={pendingRequestCount}
          onPendingMessageAppeared={onPendingMessageAppeared}
        />
        <div className={footerClassName}>
          <AgentActivityIndicator sessionId={sessionId} agentSlug={agentSlug} />
          {footer}
        </div>
      </div>
      {/* Side tray (browser, file preview) */}
      <TrayManager agentSlug={agentSlug} sessionId={sessionId} browserActive={browserActive} />
    </div>
  )
}
