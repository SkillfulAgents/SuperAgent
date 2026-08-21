import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@shared/lib/utils'
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
  /** Let transcript content scroll beneath the pinned footer while reserving
   *  enough live-edge clearance to keep the newest content readable. */
  overlayFooter?: boolean
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
  overlayFooter = false,
  browserActive = false,
  readOnly,
  pendingUserMessages,
  pendingRequestCount,
  onPendingMessageAppeared,
  suppressScrollToBottom,
}: SessionThreadProps) {
  const footerRef = useRef<HTMLDivElement>(null)
  const [footerHeight, setFooterHeight] = useState(0)

  useLayoutEffect(() => {
    if (!overlayFooter) {
      setFooterHeight(0)
      return
    }

    const footerElement = footerRef.current
    if (!footerElement) return
    const measure = () => {
      const nextHeight = Math.ceil(footerElement.getBoundingClientRect().height)
      setFooterHeight((currentHeight) => currentHeight === nextHeight ? currentHeight : nextHeight)
    }

    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(footerElement)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [overlayFooter])

  return (
    <div
      className="file-preview-container relative flex flex-1 min-h-0 min-w-0"
      data-testid="file-preview-container"
    >
      {/* Interactive sessions overlay the footer so transcript content can pass
          underneath it; read-only consumers retain the in-flow grid layout. */}
      <div
        className={cn(
          'flex-1 min-w-0 min-h-0',
          overlayFooter ? 'relative flex' : 'grid grid-rows-[1fr_auto]',
        )}
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
          bottomInset={overlayFooter ? footerHeight : 0}
        />
        <div
          ref={footerRef}
          className={cn(
            footerClassName,
            'pb-[env(safe-area-inset-bottom)]',
            overlayFooter && 'absolute inset-x-0 bottom-0 z-20',
          )}
          data-composer-footer
          data-overlay-footer={overlayFooter || undefined}
        >
          <AgentActivityIndicator sessionId={sessionId} agentSlug={agentSlug} />
          {footer}
        </div>
      </div>
      {/* Side tray (browser, file preview) */}
      <TrayManager agentSlug={agentSlug} sessionId={sessionId} browserActive={browserActive} />
    </div>
  )
}
