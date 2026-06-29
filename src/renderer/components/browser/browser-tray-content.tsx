import { useState, useEffect, useRef, useCallback } from 'react'
import { Globe, MousePointerClick, PanelRightClose, Pause, Play, Square, Expand, Shrink } from 'lucide-react'
import { BrowserActivityLog } from './browser-activity-log'
import { BrowserTabBar } from './browser-tab-bar'
import { useBrowserStream } from '@renderer/hooks/use-browser-stream'
import { Button } from '@renderer/components/ui/button'
import { DeclineButton } from '@renderer/components/messages/decline-button'
import { apiFetch } from '@renderer/lib/api'
import { removeBrowserInputRequest, useMessageStream } from '@renderer/hooks/use-message-stream'
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

  const [isPaused, setIsPaused] = useState(false)

  const handlePauseResume = useCallback(async () => {
    if (isPaused) {
      try {
        await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'resume' }),
        })
        setIsPaused(false)
      } catch (err) {
        console.error('Failed to resume session:', err)
      }
    } else {
      try {
        await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/interrupt`, {
          method: 'POST',
        })
        setIsPaused(true)
      } catch (err) {
        console.error('Failed to pause session:', err)
      }
    }
  }, [agentSlug, sessionId, isPaused])

  useEffect(() => {
    if (!browserActive) setIsPaused(false)
  }, [browserActive])

  const latestRequest = stream.pendingBrowserInputRequests.length > 0
    ? stream.pendingBrowserInputRequests[stream.pendingBrowserInputRequests.length - 1]
    : null

  // Same decline/complete behavior as the in-chat request card, shared via the hook.
  const { submittingAction, error: actionError, complete, decline } = useBrowserInputActions({
    agentSlug,
    sessionId,
    onResolved: (toolUseId) => removeBrowserInputRequest(sessionId, toolUseId),
  })

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden" data-testid="browser-drawer-panel">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground select-none shrink-0">
        <Globe className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-xs truncate font-medium">
          {stream.needsAttention ? (
            <span className="text-blue-600 dark:text-blue-400">Input needed</span>
          ) : (
            <>Browser{stream.connected ? '' : ' (connecting...)'}</>
          )}
        </span>
        <button
          className="p-0.5 rounded hover:bg-muted transition-colors"
          onClick={onClose}
          title="Hide browser panel"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      {/* Tab bar */}
      {stream.tabs.length >= 1 && (
        <BrowserTabBar
          tabs={stream.tabs}
          viewingTargetId={stream.viewingTargetId}
          autoFollow={stream.autoFollow}
          loading={stream.pageLoading}
          onTabClick={stream.handleTabClick}
          onCloseTab={stream.handleCloseTab}
          onToggleAutoFollow={stream.toggleAutoFollow}
        />
      )}

      {/* Canvas viewport */}
      <div className={cn('relative shrink-0 overflow-hidden bg-background border-y border-border/40', isActive && !stream.needsAttention && 'browser-glow-container')}>
        <canvas
          ref={canvasRef}
          className={`w-full block ${stream.isViewOnly ? 'cursor-not-allowed' : 'cursor-default'}`}
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
      </div>

      {/* Browser controls pill. translateZ(0) forces this onto its own compositing
          layer so it paints above the screencast <canvas> (which sets
          will-change: transform). Without its own layer, Safari/WebKit composites
          the canvas layer over the z-index'd pill and the controls disappear. */}
      <div
        className="sticky bottom-2 z-20 flex justify-center pointer-events-none shrink-0 -mt-10"
        style={{ transform: 'translateZ(0)' }}
      >
        <div className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2 py-1 shadow-md pointer-events-auto">
          {(isPaused || (isActive && !stream.needsAttention)) && (
            <button
              className="p-1.5 rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              onClick={handlePauseResume}
              title={isPaused ? 'Resume' : 'Pause'}
            >
              {isPaused ? <Play className="h-3.5 w-3.5 fill-current" /> : <Pause className="h-3.5 w-3.5 fill-current" />}
            </button>
          )}
          <button
            className="p-1.5 rounded-full hover:bg-muted transition-colors text-red-500 hover:text-red-600"
            onClick={stream.handleCloseClick}
            title="Stop browser"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
          <button
            className="p-1.5 rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            onClick={onToggleExpand}
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <Shrink className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Action bar */}
      {stream.needsAttention && latestRequest && (
        <div className="shrink-0 px-4 mt-3">
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3 flex items-center gap-2">
            <span className="text-xs font-medium text-foreground flex-1 truncate">
              {latestRequest.message || 'Your input needed'}
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

      {/* Activity log */}
      <div className="flex items-center gap-1 py-1.5 border-b shrink-0 mx-4 mt-4">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Activity</span>
      </div>
      <BrowserActivityLog sessionId={sessionId} agentSlug={agentSlug} />

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
