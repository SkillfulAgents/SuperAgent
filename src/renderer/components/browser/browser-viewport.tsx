import type { RefObject } from 'react'
import { MousePointerClick } from 'lucide-react'
import type { useBrowserStream } from '@renderer/hooks/use-browser-stream'
import { cn } from '@shared/lib/utils/cn'
import { BrowserViewportControls } from './browser-viewport-controls'

interface BrowserViewportProps {
  canvasRef: RefObject<HTMLCanvasElement>
  viewportRef?: RefObject<HTMLDivElement>
  stream: ReturnType<typeof useBrowserStream>
  isActive: boolean
  isExpanded: boolean
  onToggleExpand?: () => void
  /** The stop / full-screen pill; off where nobody can act on it (a meeting camera). */
  controls?: boolean
  /** Show only: no pointer or keyboard input reaches the page, whatever the viewer's role. */
  readOnly?: boolean
}

/** Keep the controls sticky to the visible rail even when a tall page overflows it. */
export function BrowserViewport({
  canvasRef,
  viewportRef,
  stream,
  isActive,
  isExpanded,
  onToggleExpand,
  controls = true,
  readOnly = false,
}: BrowserViewportProps) {
  const viewOnly = readOnly || stream.isViewOnly
  return (
    <div ref={viewportRef} className="grid shrink-0">
      {/* Canvas viewport */}
      <div
        className={cn(
          'col-start-1 row-start-1 relative overflow-hidden bg-background border-t border-border/40',
          isActive && !stream.needsAttention && 'browser-glow-container',
          !(stream.needsAttention && stream.pendingBrowserInputRequests.length > 0) && 'rounded-b-lg',
        )}
      >
        <canvas
          ref={canvasRef}
          className={cn('block w-full', viewOnly ? 'cursor-not-allowed' : 'cursor-default')}
          style={{ aspectRatio: stream.aspectRatio, willChange: 'transform' }}
          tabIndex={viewOnly ? -1 : 0}
          data-testid="browser-canvas"
          onMouseDown={viewOnly ? undefined : stream.handleMouseDown}
          onMouseUp={viewOnly ? undefined : stream.handleMouseUp}
          onMouseMove={viewOnly ? undefined : stream.handleMouseMove}
          onWheel={viewOnly ? undefined : stream.handleWheel}
          onKeyDown={viewOnly ? undefined : stream.handleKeyDown}
          onKeyUp={viewOnly ? undefined : stream.handleKeyUp}
          onPaste={viewOnly ? undefined : stream.handlePaste}
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
      {controls && <BrowserViewportControls isExpanded={isExpanded} streamScale={stream.streamScale} onCycleStreamScale={stream.cycleStreamScale} onStop={stream.handleCloseClick} onToggleExpand={onToggleExpand} />}
    </div>
  )
}
