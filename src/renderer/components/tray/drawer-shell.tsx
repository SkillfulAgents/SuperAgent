import { useState, useCallback, useLayoutEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { cn } from '@shared/lib/utils/cn'

const DEFAULT_WIDTH = 450
const MIN_WIDTH = 320
const MAX_WIDTH = 800
/**
 * The content beside the drawer never lays out narrower than this. Past it, the drawer slides over the content
 * instead of squeezing it, and dims the strip still showing.
 */
const MIN_CONTENT_WIDTH = 240
/** How far an open drawer reaches over the content beside it so the content keeps MIN_CONTENT_WIDTH. */
export function slideOverWidth(drawerWidth: number, hostWidth: number): number {
  // The drawer never renders wider than its host.
  const shown = Math.min(drawerWidth, hostWidth)
  return Math.min(shown, Math.max(0, shown - hostWidth + MIN_CONTENT_WIDTH))
}

export interface DrawerShellHandle {
  setWidth: (width: number) => void
  getWidth: () => number
}

interface DrawerShellProps {
  isOpen: boolean
  storageKey: string
  /** Expand to a full-width overlay when the containing layout is narrow. */
  responsiveFullWidth?: boolean
  /** Overlay the parent instead of participating in its wide-screen flex layout. */
  wideOverlay?: boolean
  /** Cover the whole tray host, edge to edge, ignoring the persisted width. */
  fullScreen?: boolean
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
  className?: string
  onTransitionEnd?: (e: React.TransitionEvent) => void
  children: React.ReactNode
}

export const DrawerShell = forwardRef<DrawerShellHandle, DrawerShellProps>(function DrawerShell({
  isOpen,
  storageKey,
  responsiveFullWidth = false,
  wideOverlay = false,
  fullScreen = false,
  defaultWidth = DEFAULT_WIDTH,
  minWidth = MIN_WIDTH,
  maxWidth = MAX_WIDTH,
  className,
  onTransitionEnd,
  children,
}, ref) {
  const [isResizing, setIsResizing] = useState(false)
  const [drawerWidth, setDrawerWidth] = useState(() => {
    const stored = localStorage.getItem(storageKey)
    return stored ? Number(stored) : defaultWidth
  })

  useImperativeHandle(ref, () => ({
    setWidth: (width: number) => {
      const clamped = Math.min(maxWidth, Math.max(minWidth, width))
      setDrawerWidth(clamped)
      localStorage.setItem(storageKey, String(Math.round(clamped)))
    },
    getWidth: () => drawerWidth,
  }), [drawerWidth, storageKey, minWidth, maxWidth])

  const drawerRef = useRef<HTMLDivElement>(null)
  const [hostWidth, setHostWidth] = useState(0)
  // Tracks the host's width.
  useLayoutEffect(() => {
    const host = drawerRef.current?.parentElement
    if (!host) return
    const measure = () => setHostWidth(host.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  // The overlays cover the content outright. The compact one (globals.css) also zeroes this margin and hides the scrim.
  const overlap = isOpen && !wideOverlay && !fullScreen ? slideOverWidth(drawerWidth, hostWidth) : 0

  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      startXRef.current = e.clientX
      startWidthRef.current = drawerWidth
      setIsResizing(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const dx = startXRef.current - moveEvent.clientX
        const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + dx))
        setDrawerWidth(newWidth)
      }

      const handleMouseUp = (upEvent: MouseEvent) => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setIsResizing(false)
        const dx = startXRef.current - upEvent.clientX
        const finalWidth = Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + dx))
        localStorage.setItem(storageKey, String(Math.round(finalWidth)))
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [drawerWidth, storageKey, minWidth, maxWidth]
  )

  return (
    <>
      <div
        ref={drawerRef}
        className={cn(
          'h-full border-l bg-background flex flex-col shrink-0 overflow-hidden relative z-30 shadow-[-4px_0_16px_rgba(0,0,0,0.08)] dark:shadow-[-4px_0_16px_rgba(0,0,0,0.3)]',
          responsiveFullWidth && 'file-preview-responsive-overlay',
          responsiveFullWidth && !isOpen && 'file-preview-responsive-overlay-closed',
          wideOverlay && 'file-preview-wide-overlay',
          fullScreen && 'tray-drawer-fullscreen',
          !isResizing && 'transition-[width,margin] duration-300 ease-in-out',
          className
        )}
        // A negative margin pulls the drawer over the content by the overlap.
        style={{ width: isOpen ? drawerWidth : 0, maxWidth: '100%', marginLeft: -overlap, contain: 'layout paint', willChange: 'transform' }}
        onTransitionEnd={onTransitionEnd}
        data-testid="tray-drawer"
        data-fullscreen={fullScreen || undefined}
      >
        {/* Resize handle on left edge */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          className={cn(
            'tray-drawer-resize-handle absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize hover:bg-border transition-colors',
            responsiveFullWidth && 'file-preview-responsive-resize-handle',
          )}
          onMouseDown={handleResizeMouseDown}
        />
        {children}
      </div>
      {overlap > 0 && (
        // Dims the strip of content the drawer leaves showing, and takes its clicks. The drawer sits above it.
        <div
          className={cn('absolute inset-0 z-[25] bg-black/30 animate-in fade-in-0 duration-300', responsiveFullWidth && 'file-preview-responsive-scrim')}
          aria-hidden="true"
          data-testid="tray-drawer-scrim"
        />
      )}
    </>
  )
})
