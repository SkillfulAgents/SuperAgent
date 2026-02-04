import { useState, useEffect, useRef, useCallback } from 'react'
import { Globe, ChevronUp, ChevronDown, GripHorizontal, X } from 'lucide-react'
import { getApiBaseUrl } from '@renderer/lib/env'
import { clearBrowserActive } from '@renderer/hooks/use-message-stream'
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

interface BrowserPreviewProps {
  agentSlug: string
  sessionId: string
  browserActive: boolean
  isActive: boolean
}

export function BrowserPreview({ agentSlug, sessionId, browserActive, isActive }: BrowserPreviewProps) {
  const [expanded, setExpanded] = useState(false)
  const [connected, setConnected] = useState(false)
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
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null)

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
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.width, origH: size.height }
  }, [size])

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return
    const dx = e.clientX - resizeRef.current.startX
    const ratio = metadataRef.current.deviceWidth / metadataRef.current.deviceHeight
    const newWidth = Math.max(MIN_WIDTH, resizeRef.current.origW + dx)
    const canvasHeight = newWidth / ratio
    setSize({
      width: newWidth,
      height: canvasHeight + HEADER_HEIGHT,
    })
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
    const wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws'
    const wsHost = baseUrl.replace(/^https?:\/\//, '')
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

        if (data.type === 'frame' && data.data) {
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
      fetch(`${baseUrl}/api/agents/${agentSlug}/browser/status`)
        .then((res) => res.json())
        .then((status: { active?: boolean }) => {
          if (!status.active) {
            clearBrowserActive(sessionId)
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
  }, [browserActive, expanded, agentSlug, sessionId, renderFrame])

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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      e.preventDefault()
      const printable = e.key.length === 1
      sendInput({
        type: 'input_keyboard',
        eventType: printable ? 'keyDown' : 'rawKeyDown',
        key: e.key,
        code: e.code,
        text: printable ? e.key : undefined,
        modifiers: modifierFlags(e),
      })
    },
    [sendInput, modifierFlags]
  )

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      e.preventDefault()
      sendInput({
        type: 'input_keyboard',
        eventType: 'keyUp',
        key: e.key,
        code: e.code,
        modifiers: modifierFlags(e),
      })
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
      className="flex flex-col rounded-lg border bg-background shadow-lg overflow-hidden"
    >
      {/* Drag handle / header bar */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground bg-muted/50 select-none shrink-0"
        style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
      >
        <Globe className="h-3.5 w-3.5 shrink-0" />
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
        <button
          className="p-0.5 rounded hover:bg-destructive/80 hover:text-destructive-foreground transition-colors"
          onClick={handleCloseClick}
          onPointerDown={(e) => e.stopPropagation()}
          title="Close browser"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Canvas viewport */}
      {expanded && (
        <div className="relative flex-1 min-h-0 bg-black">
          <canvas
            ref={canvasRef}
            className="w-full h-full object-contain cursor-default"
            style={{ aspectRatio }}
            tabIndex={0}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseMove={handleMouseMove}
            onWheel={handleWheel}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
          />
          {!connected && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <span className="text-white text-xs">Connecting to browser stream...</span>
            </div>
          )}

          {/* Resize grip */}
          <div
            className="absolute bottom-0 right-0 w-5 h-5 flex items-center justify-center cursor-se-resize opacity-60 hover:opacity-100 transition-opacity"
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
          >
            <GripHorizontal className="h-3 w-3 text-white rotate-[-45deg]" />
          </div>
        </div>
      )}
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
