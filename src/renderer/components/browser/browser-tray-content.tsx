import { useEffect, useRef, type MutableRefObject } from 'react'
import { BrowserViewport } from './browser-viewport'
import { BrowserToolbar } from './browser-toolbar'
import { BrowserActivityLog } from './browser-activity-log'
import type { BrowserTabInfo } from './browser-tab-bar'
import { FollowAgentToggle } from './follow-agent-toggle'
import { useBrowserStream } from '@renderer/hooks/use-browser-stream'
import { useBrowserCardSize } from '@renderer/hooks/use-browser-card-size'
import { Button } from '@renderer/components/ui/button'
import { DeclineButton } from '@shared/lib/tools/requests/decline-button'
import { linkify } from '@renderer/lib/linkify'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useBrowserInputActions } from '@shared/lib/tools/request-browser-input/use-browser-input-actions'
import { cn } from '@shared/lib/utils/cn'
import { TRAY_BODY_CLASS } from '@renderer/components/tray/tray-card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'

/** The browser's pages, as the drawer's strip lists them. */
export interface BrowserPages {
  tabs: BrowserTabInfo[]
  viewingTargetId: string | null
}

/** What the strip can ask of the browser: view a page, or close one. */
export interface BrowserPageActions {
  select: (targetId: string) => void
  close: (targetId: string) => void
}

interface BrowserTrayContentProps {
  agentSlug: string
  sessionId: string
  /** In front. Behind another tab it stays mounted, so the stream and the log keep their state. */
  visible: boolean
  /** Off while the drawer is hidden: the stream disconnects and reconnects when the drawer returns. */
  connected: boolean
  isExpanded?: boolean
  /** The pages to list in the drawer's strip; null once the browser is gone. */
  onPagesChange: (pages: BrowserPages | null) => void
  /** Filled with the page actions while the browser is up. */
  actionsRef: MutableRefObject<BrowserPageActions | null>
}

export function BrowserTrayContent({
  agentSlug,
  sessionId,
  visible,
  connected,
  isExpanded = false,
  onPagesChange,
  actionsRef,
}: BrowserTrayContentProps) {
  const { browserActive, isActive } = useMessageStream(sessionId, agentSlug, ['browserActive', 'isActive'])

  const canvasRef = useRef<HTMLCanvasElement>(null)

  const stream = useBrowserStream({
    agentSlug,
    sessionId,
    browserActive,
    isConnected: connected,
    isActive,
    canvasRef,
  })

  // The drawer's strip lists these pages beside its other tabs.
  const { tabs, viewingTargetId, handleTabClick, handleCloseTab } = stream
  useEffect(() => {
    onPagesChange({ tabs, viewingTargetId })
  }, [onPagesChange, tabs, viewingTargetId])
  useEffect(() => {
    actionsRef.current = { select: handleTabClick, close: handleCloseTab }
  })
  useEffect(() => () => {
    onPagesChange(null)
    actionsRef.current = null
  }, [onPagesChange, actionsRef])

  const { railRef, cardRef, viewportRef, maxCardWidth } = useBrowserCardSize(
    isExpanded,
    stream.aspectRatio,
  )

  const latestRequest =
    stream.pendingBrowserInputRequests.length > 0
      ? stream.pendingBrowserInputRequests[stream.pendingBrowserInputRequests.length - 1]
      : null

  // Same decline/complete behavior as the in-chat request card, shared via the hook.
  const {
    status,
    submittingAction,
    error: actionError,
    complete,
    decline,
  } = useBrowserInputActions({
    agentSlug,
    sessionId,
    toolUseId: latestRequest?.toolUseId ?? null,
    onResolved: (toolUseId) => stream.dismissBrowserInputRequest(toolUseId),
  })

  // History is authoritative once received; older containers only provide tab URLs.
  const viewingTab = stream.tabs.find((tab) => tab.targetId === stream.viewingTargetId)
  const pageUrl = stream.pageUrl || viewingTab?.url || ''

  return (
    <div
      className={cn('flex flex-col flex-1 min-h-0 overflow-hidden', !visible && 'hidden')}
      data-testid="browser-drawer-panel"
    >
      {/* Browser body, filling the drawer's card: the page with its toolbar, and the activity log below it. */}
      <div
        // 8px under the page or the log, so neither ends on the card's edge; the card size hook reads it.
        className={cn(TRAY_BODY_CLASS, 'overflow-y-auto pb-2')}
        ref={railRef}
        data-testid="browser-tray-rail"
      >
        <div
          className={cn(
            'flex w-full shrink-0 flex-col',
            isExpanded && 'self-center',
          )}
          ref={cardRef}
          style={isExpanded ? { maxWidth: maxCardWidth } : undefined}
          data-testid="browser-tray-card"
        >
          <BrowserToolbar
            url={pageUrl}
            canGoBack={stream.canGoBack}
            canGoForward={stream.canGoForward}
            connected={stream.connected}
            isViewOnly={stream.isViewOnly}
            loading={stream.pageLoading}
            needsAttention={stream.needsAttention}
            onNavigate={stream.navigate}
          />

          <BrowserViewport
            viewportRef={viewportRef}
            canvasRef={canvasRef}
            stream={stream}
            isActive={isActive}
            isExpanded={isExpanded}
          />

          {/* Action bar */}
          {stream.needsAttention && latestRequest && (
            <div className="shrink-0 px-4 py-3 border-t border-border/40">
              <div className="rounded-card border border-border/60 bg-muted/30 p-3 flex items-center gap-2">
                <span className="text-xs font-medium text-foreground flex-1 truncate">
                  {latestRequest.message ? linkify(latestRequest.message) : 'Your input needed'}
                </span>
                <DeclineButton
                  onDecline={decline}
                  disabled={status !== 'pending'}
                  label="Decline"
                  showIcon={false}
                  size="sm"
                  // Chevron sits inside the grey action bar; clear the bar's bottom edge
                  // (plus a small gap) rather than offsetting from the chevron.
                  popoverSideOffset={18}
                  className="h-7 text-xs border-border text-foreground hover:bg-muted"
                  data-testid="browser-tray-decline-btn"
                />
                <Button
                  onClick={() => complete()}
                  loading={submittingAction === 'completing'}
                  disabled={status !== 'pending'}
                  size="sm"
                  className="h-7 text-xs bg-blue-600 text-white hover:bg-blue-700"
                  data-testid="browser-tray-complete-btn"
                >
                  Done
                </Button>
              </div>
              {actionError && <p className="mt-1 px-1 text-2xs text-destructive">{actionError}</p>}
            </div>
          )}
        </div>

        {/* Preserve subscriptions, expanded rows, and scroll position across full screen. */}
        <div
          className={cn('flex flex-1 min-h-32 flex-col px-2', isExpanded && 'hidden')}
          data-testid="browser-activity-region"
        >
          {/* Activity log, below the page, in 8px. The log pads its own
          rows 16px, so it is pulled back out to that 8px edge, and the heading
          takes the same 16px to line up with the rows. */}
          <div className="flex items-center px-2 py-1 border-b border-border/60 shrink-0 mt-4">
            <span className="flex-1 text-xs font-medium text-muted-foreground">Browser agent actions</span>
            {/* Follow changes the viewed browser tab when the agent switches pages. */}
            <FollowAgentToggle autoFollow={stream.autoFollow} onToggle={stream.toggleAutoFollow} className="-mr-1" />
          </div>
          <div className="flex flex-1 min-h-0 flex-col -mx-2">
            <BrowserActivityLog sessionId={sessionId} agentSlug={agentSlug} />
          </div>
        </div>
      </div>

      {/* Close confirmation dialog */}
      <AlertDialog open={stream.showCloseWarning} onOpenChange={stream.setShowCloseWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close Browser</AlertDialogTitle>
            <AlertDialogDescription>
              The agent is currently running. Closing the browser will interrupt the active session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={stream.closeBrowser}
              disabled={stream.isClosing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {stream.isClosing ? 'Closing...' : 'Close Browser'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
