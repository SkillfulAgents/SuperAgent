import { useState, useRef, useCallback } from 'react'
import { PanelRight } from 'lucide-react'
import { BrowserViewport } from './browser-viewport'
import { BrowserToolbar } from './browser-toolbar'
import { BrowserActivityLog } from './browser-activity-log'
import { BrowserTabBar } from './browser-tab-bar'
import { FollowAgentToggle } from './follow-agent-toggle'
import { useBrowserStream } from '@renderer/hooks/use-browser-stream'
import { useBrowserCardSize } from '@renderer/hooks/use-browser-card-size'
import { Button } from '@renderer/components/ui/button'
import { DeclineButton } from '@renderer/components/messages/decline-button'
import { linkify } from '@renderer/lib/linkify'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useBrowserInputActions } from '@renderer/hooks/use-browser-input-actions'
import { cn } from '@shared/lib/utils/cn'
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

interface BrowserTrayContentProps {
  agentSlug: string
  sessionId: string
  onClose: () => void
  isExpanded?: boolean
  onToggleExpand?: () => void
}

export function BrowserTrayContent({
  agentSlug,
  sessionId,
  onClose,
  isExpanded = false,
  onToggleExpand,
}: BrowserTrayContentProps) {
  const { browserActive, isActive } = useMessageStream(sessionId, agentSlug)

  const canvasRef = useRef<HTMLCanvasElement>(null)

  const stream = useBrowserStream({
    agentSlug,
    sessionId,
    browserActive,
    isConnected: true,
    isActive,
    canvasRef,
  })

  // The body card squares off its top-left corner only while the viewed tab sits
  // directly above it; the strip is the only thing that knows when that is.
  const [leadingTabFlush, setLeadingTabFlush] = useState(false)
  const onLeadingTabFlush = useCallback((flush: boolean) => setLeadingTabFlush(flush), [])

  const { railRef, cardRef, viewportRef, maxCardWidth, maxStripWidth } = useBrowserCardSize(
    isExpanded,
    stream.aspectRatio,
  )

  const latestRequest =
    stream.pendingBrowserInputRequests.length > 0
      ? stream.pendingBrowserInputRequests[stream.pendingBrowserInputRequests.length - 1]
      : null

  // Same decline/complete behavior as the in-chat request card, shared via the hook.
  const {
    submittingAction,
    error: actionError,
    complete,
    decline,
  } = useBrowserInputActions({
    agentSlug,
    sessionId,
    onResolved: (toolUseId) => stream.dismissBrowserInputRequest(toolUseId),
  })

  // History is authoritative once received; older containers only provide tab URLs.
  const viewingTab = stream.tabs.find((tab) => tab.targetId === stream.viewingTargetId)
  const pageUrl = stream.pageUrl || viewingTab?.url || ''

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden" data-testid="browser-drawer-panel">
      {/* Page tabs, with the drawer's own hide control at the strip's right end. */}
      <div className="shrink-0 bg-muted/60">
        <div className={cn(isExpanded && 'mx-auto')} style={isExpanded ? { maxWidth: maxStripWidth } : undefined}>
          <BrowserTabBar
            tabs={stream.tabs}
            viewingTargetId={stream.viewingTargetId}
            onTabClick={stream.handleTabClick}
            onCloseTab={stream.handleCloseTab}
            onLeadingTabFlush={onLeadingTabFlush}
            trailing={
              // The drawer's own control, at the strip's right end like the file drawer's.
              <button
                type="button"
                className="inline-flex p-0.5 rounded hover:bg-muted transition-colors"
                onClick={onClose}
                title="Hide browser panel"
                aria-label="Hide browser panel"
              >
                <PanelRight className="h-4 w-4" />
              </button>
            }
          />
        </div>
      </div>

      {/* Browser body, on the same gray as the tab rail: the page card inset 16px
          on every side, with the activity log sitting directly on the rail below it. */}
      <div
        className="flex flex-1 min-h-0 flex-col overflow-y-auto bg-muted/60 px-4 pb-4"
        ref={railRef}
        data-testid="browser-tray-rail"
      >
        <div
          className={cn(
            'flex w-full shrink-0 flex-col rounded-lg border border-black/5 bg-background shadow-[0_1px_3px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.03)] dark:border-white/5 dark:shadow-[0_1px_3px_rgba(0,0,0,0.2),0_2px_8px_rgba(0,0,0,0.15)]',
            // Square only where a tab actually meets the corner.
            leadingTabFlush && 'rounded-tl-none',
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
            onToggleExpand={onToggleExpand}
          />

          {/* Action bar */}
          {stream.needsAttention && latestRequest && (
            <div className="shrink-0 px-4 py-3 border-t border-border/40">
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3 flex items-center gap-2">
                <span className="text-xs font-medium text-foreground flex-1 truncate">
                  {latestRequest.message ? linkify(latestRequest.message) : 'Your input needed'}
                </span>
                <DeclineButton
                  onDecline={(reason) => decline(latestRequest.toolUseId, reason)}
                  disabled={submittingAction !== null}
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
                  onClick={() => complete(latestRequest.toolUseId)}
                  loading={submittingAction === 'completing'}
                  disabled={submittingAction !== null}
                  size="sm"
                  className="h-7 text-xs bg-blue-600 text-white hover:bg-blue-700"
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
          className={cn('flex flex-1 min-h-32 flex-col', isExpanded && 'hidden')}
          data-testid="browser-activity-region"
        >
          {/* Activity log, on the rail rather than in the card. The log pads its own
          rows 16px, so it is pulled back out to the rail's edge to line up with
          the heading and the card. */}
          <div className="flex items-center py-1 border-b border-border/60 shrink-0 mt-4">
            <span className="flex-1 text-xs font-medium text-muted-foreground">Browser agent actions</span>
            {/* Follow changes the viewed browser tab when the agent switches pages. */}
            <FollowAgentToggle autoFollow={stream.autoFollow} onToggle={stream.toggleAutoFollow} className="-mr-1" />
          </div>
          <div className="flex flex-1 min-h-0 flex-col -mx-4">
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
