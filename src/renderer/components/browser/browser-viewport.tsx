import type { RefObject } from 'react'
import { Expand, MousePointerClick, Shrink, Square } from 'lucide-react'
import type { useBrowserStream } from '@renderer/hooks/use-browser-stream'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'

interface BrowserViewportProps {
  canvasRef: RefObject<HTMLCanvasElement>
  viewportRef?: RefObject<HTMLDivElement>
  stream: ReturnType<typeof useBrowserStream>
  isActive: boolean
  isExpanded: boolean
  onToggleExpand?: () => void
}

/** Keep the controls sticky to the visible rail even when a tall page overflows it. */
export function BrowserViewport({
  canvasRef,
  viewportRef,
  stream,
  isActive,
  isExpanded,
  onToggleExpand,
}: BrowserViewportProps) {
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
      </div>
      {/* Controls pill, floating over the bottom of the page. translateZ(0)
              forces it onto its own compositing layer so it paints above the
              screencast <canvas> (which sets will-change: transform); without
              it Safari/WebKit composites the canvas over the pill. */}
      <div
        className="sticky bottom-2 z-20 col-start-1 row-start-1 mb-2 self-end flex justify-center pointer-events-none"
        style={{ transform: 'translateZ(0)' }}
        data-testid="browser-tray-pill"
      >
        <TooltipProvider delayDuration={300}>
          <div className="inline-flex items-center gap-1 pointer-events-auto rounded-full border border-border/60 bg-background px-2 py-1 shadow-md">
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
                  aria-label={isExpanded ? 'Exit full screen' : 'Full screen'}
                  data-testid="browser-tray-fullscreen"
                  className="p-1.5 rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {isExpanded ? <Shrink className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{isExpanded ? 'Exit full screen' : 'Full screen'}</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>
    </div>
  )
}
