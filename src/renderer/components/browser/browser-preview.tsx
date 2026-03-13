import { useState, useEffect, useRef, useCallback } from 'react'
import { Globe, ChevronUp, ChevronDown, X, Loader2 } from 'lucide-react'
import { getApiBaseUrl } from '@renderer/lib/env'
import { clearBrowserActive } from '@renderer/hooks/use-message-stream'
import { useUser } from '@renderer/context/user-context'
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

const DEFAULT_WIDTH = 380
const HEADER_HEIGHT = 32
const MIN_WIDTH = 240
const EDGE_OFFSET = 16
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

type Corner = 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']
const CORNER_CONFIG: Record<Corner, { position: string; cursor: string; rotation: number }> = {
  nw: { position: '-top-0.5 -left-0.5', cursor: 'cursor-nw-resize', rotation: 180 },
  ne: { position: '-top-0.5 -right-0.5', cursor: 'cursor-ne-resize', rotation: -90 },
  sw: { position: '-bottom-0.5 -left-0.5', cursor: 'cursor-sw-resize', rotation: 90 },
  se: { position: '-bottom-0.5 -right-0.5', cursor: 'cursor-se-resize', rotation: 0 },
}

interface BrowserPreviewProps {
  agentSlug: string
  sessionId: string
  browserActive: boolean
  isActive: boolean
}

export function BrowserPreview({ agentSlug, sessionId, browserActive, isActive }: BrowserPreviewProps) {
  const { canUseAgent } = useUser()
  const isViewOnly = !canUseAgent(agentSlug)
  const [expanded, setExpanded] = useState(false)
  const [connected, setConnected] = useState(false)
  const [pageLoading, setPageLoading] = useState(false)
  const [reconnectKey, setReconnectKey] = useState(0)
  const [showCloseWarning, setShowCloseWarning] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [aspectRatio, setAspectRatio] = useState('16 / 9')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const metadataRef = useRef<{ deviceWidth: number; deviceHeight: number }>({
    deviceWidth: 1280,
    deviceHeight: 720,
  })

  // Floating position & size (null = not yet initialized, will snap to bottom-right)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState(() => ({
    width: DEFAULT_WIDTH,
    height: DEFAULT_WIDTH / (16 / 9) + HEADER_HEIGHT,
  }))

  // Drag state
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)

  // Resize state
  const resizeRef = useRef<{
    startX: number; startY: number;
    origW: number; origH: number;
    origX: number; origY: number;
    corner: Corner;
  } | null>(null)
  const sizeRef = useRef(size)
  sizeRef.current = size
  const posRef = useRef(pos)
  posRef.current = pos

  // Initialize position to bottom-right of parent on first render
  useEffect(() => {
    if (!browserActive || pos !== null) return
    const parent = containerRef.current?.parentElement
    if (parent) {
      const rect = parent.getBoundingClientRect()
      const defaultHeight = DEFAULT_WIDTH / (16 / 9) + HEADER_HEIGHT
      setPos({
        x: rect.width - DEFAULT_WIDTH - EDGE_OFFSET,
        y: rect.height - defaultHeight - EDGE_OFFSET,
      })
    }
  }, [browserActive, pos])

  // --- Drag handlers ---
  const handleDragStart = useCallback((e: React.PointerEvent) => {
    if (!pos) return
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y }
  }, [pos])

  const handleDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const parent = containerRef.current?.parentElement
    const el = containerRef.current
    if (!parent || !el) return
    const parentRect = parent.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    setPos({
      x: Math.max(0, Math.min(parentRect.width - elRect.width, dragRef.current.origX + dx)),
      y: Math.max(0, Math.min(parentRect.height - elRect.height, dragRef.current.origY + dy)),
    })
  }, [])

  const handleDragEnd = useCallback(() => {
    dragRef.current = null
  }, [])

  // --- Resize handlers ---
  const handleResizeStart = useCallback((corner: Corner) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    resizeRef.current = {
      startX: e.clientX, startY: e.clientY,
      origW: sizeRef.current.width, origH: sizeRef.current.height,
      origX: posRef.current?.x ?? 0, origY: posRef.current?.y ?? 0,
      corner,
    }
  }, [])

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return
    const parent = containerRef.current?.parentElement
    if (!parent) return
    const parentRect = parent.getBoundingClientRect()

    const { startX, origW, origH, origX, origY, corner } = resizeRef.current
    const dx = e.clientX - startX
    const ratio = metadataRef.current.deviceWidth / metadataRef.current.deviceHeight

    const isLeft = corner === 'nw' || corner === 'sw'
    const isTop = corner === 'nw' || corner === 'ne'

    let newWidth = Math.max(MIN_WIDTH, isLeft ? origW - dx : origW + dx)
    let newX = isLeft ? origX - (newWidth - origW) : origX
    let newY = isTop ? origY - (newWidth / ratio + HEADER_HEIGHT - origH) : origY

    // Clamp so the window stays within the parent container
    if (newX < 0) { newWidth += newX; newX = 0 }
    if (newY < 0) { newWidth += newY * ratio; newY = 0 }
    if (newX + newWidth > parentRect.width) newWidth = parentRect.width - newX
    newWidth = Math.max(MIN_WIDTH, newWidth)

    const newHeight = newWidth / ratio + HEADER_HEIGHT
    if (newY + newHeight > parentRect.height) {
      newWidth = (parentRect.height - newY - HEADER_HEIGHT) * ratio
      newWidth = Math.max(MIN_WIDTH, newWidth)
    }

    setSize({ width: newWidth, height: newWidth / ratio + HEADER_HEIGHT })
    setPos({ x: newX, y: newY })
  }, [])

  const handleResizeEnd = useCallback(() => {
    resizeRef.current = null
  }, [])

  // --- Frame rendering ---
  const renderFrame = useCallback((blob: Blob) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const img = new Image()
    img.onload = () => {
      if (canvas.width !== img.width || canvas.height !== img.height) {
        canvas.width = img.width
        canvas.height = img.height
        setAspectRatio(`${img.width} / ${img.height}`)
        // Re-lock window size to new aspect ratio
        setSize((prev) => ({
          width: prev.width,
          height: prev.width / (img.width / img.height) + HEADER_HEIGHT,
        }))
      }
      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(img.src)
    }
    img.src = URL.createObjectURL(blob)
  }, [])

  // --- WebSocket connection ---
  useEffect(() => {
    if (!browserActive || !expanded) {
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
        setConnected(false)
      }
      return
    }

    const baseUrl = getApiBaseUrl()
    const wsProtocol = baseUrl.startsWith('https') || window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsHost = baseUrl ? baseUrl.replace(/^https?:\/\//, '') : window.location.host
    const wsUrl = `${wsProtocol}://${wsHost}/api/agents/${agentSlug}/browser/stream`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
    }

    ws.onmessage = (event) => {
      try {
        if (event.data instanceof Blob) {
          renderFrame(event.data)
          return
        }

        const data = typeof event.data === 'string' ? JSON.parse(event.data) : null
        if (!data) return

        if (data.type === 'page_loading') {
          setPageLoading(data.loading)
        } else if (data.type === 'metadata') {
          metadataRef.current = {
            deviceWidth: data.deviceWidth || 1280,
            deviceHeight: data.deviceHeight || 720,
          }
        } else if (data.type === 'frame' && data.data) {
          const blob = base64ToBlob(data.data, 'image/jpeg')
          renderFrame(blob)

          if (data.metadata) {
            metadataRef.current = {
              deviceWidth: data.metadata.deviceWidth || 1280,
              deviceHeight: data.metadata.deviceHeight || 720,
            }
          }
        }
      } catch {
        // Ignore parse errors for binary frames
      }
    }

    ws.onclose = () => {
      setConnected(false)
      setPageLoading(false)
      fetch(`${baseUrl}/api/agents/${agentSlug}/browser/status`)
        .then((res) => res.json())
        .then((status: { active?: boolean; sessionId?: string }) => {
          if (!status.active || status.sessionId !== sessionId) {
            clearBrowserActive(sessionId)
          } else {
            // Browser still active but stream dropped (e.g. tab switch disrupted
            // CDP screencast). Retry after a brief delay.
            setTimeout(() => setReconnectKey(k => k + 1), 1000)
          }
        })
        .catch(() => {
          clearBrowserActive(sessionId)
        })
    }

    ws.onerror = () => {
      setConnected(false)
    }

    return () => {
      ws.close()
      wsRef.current = null
      setConnected(false)
    }
  }, [browserActive, expanded, agentSlug, sessionId, renderFrame, reconnectKey])

  // Auto-expand when browser becomes active
  useEffect(() => {
    if (browserActive) {
      setExpanded(true)
    } else {
      setExpanded(false)
    }
  }, [browserActive])

  // --- Canvas input handlers ---
  const mapCoordinates = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return { x: 0, y: 0 }

      const rect = canvas.getBoundingClientRect()
      const scaleX = metadataRef.current.deviceWidth / rect.width
      const scaleY = metadataRef.current.deviceHeight / rect.height
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
      }
    },
    []
  )

  const sendInput = useCallback(
    (message: Record<string, unknown>) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(message))
      }
    },
    []
  )

  const buttonName = useCallback((button: number): string => {
    switch (button) {
      case 0: return 'left'
      case 1: return 'middle'
      case 2: return 'right'
      default: return 'none'
    }
  }, [])

  const modifierFlags = useCallback((e: React.MouseEvent | React.KeyboardEvent | React.WheelEvent): number => {
    let flags = 0
    if (e.altKey) flags |= 1
    if (e.ctrlKey) flags |= 2
    if (e.metaKey) flags |= 4
    if (e.shiftKey) flags |= 8
    return flags
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = mapCoordinates(e)
      sendInput({ type: 'input_mouse', eventType: 'mousePressed', x, y, button: buttonName(e.button), clickCount: 1, modifiers: modifierFlags(e) })
    },
    [mapCoordinates, sendInput, buttonName, modifierFlags]
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = mapCoordinates(e)
      sendInput({ type: 'input_mouse', eventType: 'mouseReleased', x, y, button: buttonName(e.button), modifiers: modifierFlags(e) })
    },
    [mapCoordinates, sendInput, buttonName, modifierFlags]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = mapCoordinates(e)
      sendInput({ type: 'input_mouse', eventType: 'mouseMoved', x, y, button: 'none', modifiers: modifierFlags(e) })
    },
    [mapCoordinates, sendInput, modifierFlags]
  )

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      const { x, y } = mapCoordinates(e)
      sendInput({
        type: 'input_mouse',
        eventType: 'mouseWheel',
        x,
        y,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        button: 'none',
        modifiers: modifierFlags(e),
      })
    },
    [mapCoordinates, sendInput, modifierFlags]
  )

  const pressKeyViaHttp = useCallback(
    (key: string, mods: number) => {
      // Build Playwright-style combo: "Meta+Shift+ArrowLeft", "Control+a", etc.
      const parts: string[] = []
      if (mods & 2) parts.push('Control')
      if (mods & 1) parts.push('Alt')
      if (mods & 4) parts.push('Meta')
      if (mods & 8) parts.push('Shift')
      parts.push(key)
      const combo = parts.join('+')

      const baseUrl = getApiBaseUrl()
      fetch(`${baseUrl}/api/agents/${agentSlug}/browser/press`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, key: combo }),
      }).catch(() => {
        // Ignore errors — fire-and-forget for responsiveness
      })
    },
    [agentSlug, sessionId]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLCanvasElement>) => {
      e.preventDefault()
      const text = e.clipboardData.getData('text/plain')
      if (text) {
        sendInput({ type: 'input_paste', text })
      }
    },
    [sendInput]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      // Let paste shortcut through so the native paste event fires
      if (e.key === 'v' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        return
      }

      e.preventDefault()
      const printable = e.key.length === 1

      if (printable) {
        // Printable characters: send via WebSocket stream (low latency, works via CDP text field)
        sendInput({
          type: 'input_keyboard',
          eventType: 'keyDown',
          key: e.key,
          code: e.code,
          text: e.key,
          modifiers: modifierFlags(e),
        })
      } else if (!MODIFIER_KEYS.has(e.key)) {
        // Non-printable, non-modifier keys (Backspace, Arrow, Enter, Tab, Escape, etc.):
        // Use HTTP press endpoint which goes through Playwright's keyboard API
        // (properly sets windowsVirtualKeyCode in CDP, unlike the stream path)
        pressKeyViaHttp(e.key, modifierFlags(e))
      }
      // Pure modifier keys (Shift, Ctrl, etc.) alone: ignore — they're included
      // in the combo string when a non-modifier key is pressed with them.
    },
    [sendInput, modifierFlags, pressKeyViaHttp]
  )

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      e.preventDefault()
      // Only send keyUp for printable characters via stream.
      // Non-printable keys use press (which sends both down+up).
      if (e.key.length === 1) {
        sendInput({
          type: 'input_keyboard',
          eventType: 'keyUp',
          key: e.key,
          code: e.code,
          modifiers: modifierFlags(e),
        })
      }
    },
    [sendInput, modifierFlags]
  )

  const closeBrowser = useCallback(async () => {
    const baseUrl = getApiBaseUrl()
    setIsClosing(true)
    try {
      if (isActive) {
        // Interrupt the session first
        await fetch(`${baseUrl}/api/agents/${agentSlug}/sessions/${sessionId}/interrupt`, {
          method: 'POST',
        })
      }
      // Close the browser
      await fetch(`${baseUrl}/api/agents/${agentSlug}/browser/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      clearBrowserActive(sessionId)
    } catch (error) {
      console.error('Failed to close browser:', error)
    } finally {
      setIsClosing(false)
      setShowCloseWarning(false)
    }
  }, [agentSlug, sessionId, isActive])

  const handleCloseClick = useCallback(() => {
    if (isActive) {
      setShowCloseWarning(true)
    } else {
      closeBrowser()
    }
  }, [isActive, closeBrowser])

  if (!browserActive) return null

  const floatStyle: React.CSSProperties = pos
    ? {
        position: 'absolute',
        left: pos.x,
        top: pos.y,
        width: expanded ? size.width : 'auto',
        height: expanded ? size.height : 'auto',
        zIndex: 50,
      }
    : {
        position: 'absolute',
        right: EDGE_OFFSET,
        bottom: EDGE_OFFSET,
        width: expanded ? size.width : 'auto',
        height: expanded ? size.height : 'auto',
        zIndex: 50,
      }

  return (
    <>
    <div
      ref={containerRef}
      style={floatStyle}
      className="flex flex-col rounded-lg border bg-background shadow-lg overflow-visible"
      data-testid="browser-preview"
    >
      {/* Drag handle / header bar */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground bg-muted/50 select-none shrink-0 rounded-t-lg"
        style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
      >
        {pageLoading ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <Globe className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="flex-1 text-xs truncate">
          Browser{connected ? '' : ' (connecting...)'}
        </span>
        <button
          className="p-0.5 rounded hover:bg-muted transition-colors"
          onClick={() => setExpanded(!expanded)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" />
          )}
        </button>
        {!isViewOnly && (
          <button
            className="p-0.5 rounded hover:bg-destructive/80 hover:text-destructive-foreground transition-colors"
            onClick={handleCloseClick}
            onPointerDown={(e) => e.stopPropagation()}
            title="Close browser"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Canvas viewport */}
      {expanded && (
        <div className="relative flex-1 min-h-0 bg-black rounded-b-lg overflow-hidden">
          <canvas
            ref={canvasRef}
            className={`w-full h-full object-contain ${isViewOnly ? 'cursor-not-allowed' : 'cursor-default'}`}
            style={{ aspectRatio }}
            tabIndex={isViewOnly ? -1 : 0}
            data-testid="browser-canvas"
            onMouseDown={isViewOnly ? undefined : handleMouseDown}
            onMouseUp={isViewOnly ? undefined : handleMouseUp}
            onMouseMove={isViewOnly ? undefined : handleMouseMove}
            onWheel={isViewOnly ? undefined : handleWheel}
            onKeyDown={isViewOnly ? undefined : handleKeyDown}
            onKeyUp={isViewOnly ? undefined : handleKeyUp}
            onPaste={isViewOnly ? undefined : handlePaste}
          />
          {!connected && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <span className="text-white text-xs">Connecting to browser stream...</span>
            </div>
          )}

        </div>
      )}

      {/* Corner resize handles — diagonal grip lines */}
      {expanded && CORNERS.map((corner) => {
        const { position, cursor, rotation } = CORNER_CONFIG[corner]
        return (
          <div
            key={corner}
            className={`absolute z-[51] w-5 h-5 flex items-center justify-center opacity-60 hover:opacity-100 transition-opacity ${position} ${cursor}`}
            onPointerDown={handleResizeStart(corner)}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" style={{ transform: `rotate(${rotation}deg)` }}>
              <line x1="2" y1="10" x2="10" y2="2" stroke="currentColor" strokeWidth="1.2" className="text-gray-400 dark:text-white" />
              <line x1="5" y1="10" x2="10" y2="5" stroke="currentColor" strokeWidth="1.2" className="text-gray-400 dark:text-white" />
              <line x1="8" y1="10" x2="10" y2="8" stroke="currentColor" strokeWidth="1.2" className="text-gray-400 dark:text-white" />
            </svg>
          </div>
        )
      })}
    </div>

    <AlertDialog open={showCloseWarning} onOpenChange={setShowCloseWarning}>
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
            onClick={closeBrowser}
            disabled={isClosing}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isClosing ? 'Closing...' : 'Close Browser'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const byteCharacters = atob(base64)
  const byteNumbers = new Array(byteCharacters.length)
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i)
  }
  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType })
}
