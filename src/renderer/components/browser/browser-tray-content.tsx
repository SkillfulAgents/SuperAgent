import { useState, useRef, useCallback } from 'react'
import { Expand, MousePointerClick, PanelRight, Shrink, Square } from 'lucide-react'
import { BrowserActivityLog } from './browser-activity-log'
import { BrowserTabBar } from './browser-tab-bar'
import { useBrowserStream } from '@renderer/hooks/use-browser-stream'
import { Button } from '@renderer/components/ui/button'
import { DeclineButton } from '@renderer/components/messages/decline-button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
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

/** The host of a page URL, for the title row's secondary text; nothing for a URL that will not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
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

  const latestRequest = stream.pendingBrowserInputRequests.length > 0
    ? stream.pendingBrowserInputRequests[stream.pendingBrowserInputRequests.length - 1]
    : null

  // Same decline/complete behavior as the in-chat request card, shared via the hook.
  const { submittingAction, error: actionError, complete, decline } = useBrowserInputActions({
    agentSlug,
    sessionId,
    onResolved: (toolUseId) => stream.dismissBrowserInputRequest(toolUseId),
  })

  // The card is headed by the page the user is looking at, the way the file
  // card is headed by its filename. Before any tab exists it is just "Browser".
  const viewingTab = stream.tabs.find((tab) => tab.targetId === stream.viewingTargetId) ?? null
  const title = viewingTab?.title || 'Browser'
  const host = viewingTab ? hostOf(viewingTab.url) : null

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden" data-testid="browser-drawer-panel">
      {/* Page tabs, with the drawer's own hide control at the strip's right end. */}
      <BrowserTabBar
        tabs={stream.tabs}
        viewingTargetId={stream.viewingTargetId}
        autoFollow={stream.autoFollow}
        loading={stream.pageLoading}
        onTabClick={stream.handleTabClick}
        onCloseTab={stream.handleCloseTab}
        onToggleAutoFollow={stream.toggleAutoFollow}
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

      {/* Browser body, on the same gray as the tab rail: the page card inset 16px
          on every side, with the activity log sitting directly on the rail below it. */}
      <div className="flex flex-1 min-h-0 flex-col bg-muted/60 px-4 pb-4">
      <div
        className={cn(
          'flex w-full shrink-0 flex-col overflow-hidden rounded-lg border border-black/5 bg-background shadow-[0_1px_3px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.03)] dark:border-white/5 dark:shadow-[0_1px_3px_rgba(0,0,0,0.2),0_2px_8px_rgba(0,0,0,0.15)]',
          // Square only where a tab actually meets the corner.
          leadingTabFlush && 'rounded-tl-none',
        )}
        data-testid="browser-tray-card"
      >
        {/* Title row: the viewed page and its state. */}
        <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2" data-testid="browser-tray-title">
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h2 className="truncate text-sm font-medium text-foreground">{title}</h2>
            {stream.needsAttention ? (
              <span className="shrink-0 text-xs font-normal text-blue-600 dark:text-blue-400">Input needed</span>
            ) : !stream.connected ? (
              <span className="shrink-0 text-xs font-normal text-muted-foreground">Connecting…</span>
            ) : host ? (
              <span className="truncate text-xs font-normal text-muted-foreground" data-testid="browser-tray-host">{host}</span>
            ) : null}
          </div>
        </div>

        {/* Canvas viewport */}
        <div
          className={cn(
            'relative shrink-0 overflow-hidden bg-background border-t border-border/40',
            isActive && !stream.needsAttention && 'browser-glow-container',
          )}
        >
          <canvas
            ref={canvasRef}
            className={cn('block w-full', stream.isViewOnly ? 'cursor-not-allowed' : 'cursor-default')}
            style={{ aspectRatio: stream.aspectRatio, willChange: 'transform' }}
            tabIndex={stream.isViewOnly ? -1 : 0}
            data-testid="browser-canvas"
            onMouseDown={stream.isViewOnly ? undefined : stream.handleMouseDown}
            onMouseUp={stream.isViewOnly ? undefined : stream.handleMouseUp}
            onMouseMove={stream.isViewOnly ? undefined : stream.handleMouseMove}
            onWheel={stream.isViewOnly ? undefined : stream.handleWheel}
            onKeyDown={stream.isViewOnly ? undefined : stream.handleKeyDown}
            onKeyUp={stream.isViewOnly ? undefined : stream.handleKeyUp}
            onPaste={stream.isViewOnly ? undefined : stream.handlePaste}
            onContextMenu={(e) => e.preventDefault()}
          />
          {!stream.connected && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <span className="text-white text-xs">Connecting to browser stream...</span>
            </div>
          )}
          {stream.showOverlay && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm cursor-pointer z-10 transition-opacity duration-300"
              role="button"
              tabIndex={0}
              onClick={stream.dismissOverlay}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  stream.dismissOverlay()
                }
              }}
            >
              <span className="relative flex h-3 w-3 mb-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
              </span>
              <span className="text-white text-sm font-medium mb-3">Your input needed</span>
              <MousePointerClick className="h-6 w-6 text-white animate-pulse" />
              <span className="text-white/70 text-xs mt-1">Click to interact</span>
            </div>
          )}

          {/* Controls pill, floating over the bottom of the page. translateZ(0)
              forces it onto its own compositing layer so it paints above the
              screencast <canvas> (which sets will-change: transform); without
              it Safari/WebKit composites the canvas over the pill. */}
          <div
            className="absolute bottom-2 left-1/2 z-20"
            style={{ transform: 'translateX(-50%) translateZ(0)' }}
            data-testid="browser-tray-pill"
          >
            <TooltipProvider delayDuration={300}>
            <div className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2 py-1 shadow-md">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={stream.handleCloseClick}
                    aria-label="Stop browser agent"
                    data-testid="browser-tray-stop"
                    className="p-1.5 rounded-full text-red-500 transition-colors hover:bg-muted hover:text-red-600"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Stop browser agent</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onToggleExpand}
                    aria-label={isExpanded ? 'Collapse' : 'Expand'}
                    data-testid="browser-tray-expand"
                    className="p-1.5 rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {isExpanded ? <Shrink className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{isExpanded ? 'Collapse' : 'Expand'}</TooltipContent>
              </Tooltip>
            </div>
            </TooltipProvider>
          </div>
        </div>

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
            {actionError && (
              <p className="mt-1 px-1 text-2xs text-destructive">{actionError}</p>
            )}
          </div>
        )}

      </div>

      {/* Activity log, on the rail rather than in the card. The log pads its own
          rows 16px, so it is pulled back out to the rail's edge to line up with
          the heading and the card. */}
      <div className="flex items-center gap-1 py-1.5 border-b border-border/60 shrink-0 mt-4">
        <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Activity</span>
      </div>
      <div className="flex flex-1 min-h-0 flex-col -mx-4">
        <BrowserActivityLog sessionId={sessionId} agentSlug={agentSlug} />
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
