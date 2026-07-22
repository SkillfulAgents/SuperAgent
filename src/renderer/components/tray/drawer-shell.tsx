import { useState, useCallback, useRef, useImperativeHandle, forwardRef } from 'react'
import { cn } from '@shared/lib/utils/cn'

const DEFAULT_WIDTH = 450
const MIN_WIDTH = 320
const MAX_WIDTH = 800

export interface DrawerShellHandle {
  setWidth: (width: number) => void
  getWidth: () => number
}

interface DrawerShellProps {
  isOpen: boolean
  storageKey: string
  /** Overlay the parent at drawer width, expanding to full width when it is narrow. */
  responsiveFullWidth?: boolean
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
    <div
      className={cn(
        'h-full border-l bg-background flex flex-col shrink-0 overflow-hidden relative shadow-[-4px_0_16px_rgba(0,0,0,0.08)] dark:shadow-[-4px_0_16px_rgba(0,0,0,0.3)]',
        responsiveFullWidth && 'file-preview-responsive-overlay',
        responsiveFullWidth && !isOpen && 'file-preview-responsive-overlay-closed',
        !isResizing && 'transition-[width] duration-300 ease-in-out',
        className
      )}
      style={{ width: isOpen ? drawerWidth : 0, maxWidth: '100%', contain: 'layout paint', willChange: 'transform' }}
      onTransitionEnd={onTransitionEnd}
    >
      {/* Resize handle on left edge */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className={cn(
          'absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize hover:bg-border transition-colors',
          responsiveFullWidth && 'file-preview-responsive-resize-handle',
        )}
        onMouseDown={handleResizeMouseDown}
      />
      {children}
    </div>
  )
})
