import { Expand, Shrink, Square } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'

interface BrowserViewportControlsProps {
  isExpanded: boolean
  onStop: () => void
  onToggleExpand?: () => void
}

/**
 * The stop / full-screen pill floating over the bottom of the page.
 * translateZ(0) forces it onto its own compositing layer so it paints above
 * the screencast <canvas> (which sets will-change: transform); without it
 * Safari/WebKit composites the canvas over the pill.
 */
export function BrowserViewportControls({ isExpanded, onStop, onToggleExpand }: BrowserViewportControlsProps) {
  return (
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
                onClick={onStop}
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
  )
}
