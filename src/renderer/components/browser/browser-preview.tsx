import { useState, useEffect, useRef, useCallback } from 'react'
import { Globe, ChevronUp, ChevronDown, X, MousePointerClick } from 'lucide-react'
import { BrowserTabBar, type BrowserTabInfo } from './browser-tab-bar'
import { getApiBaseUrl } from '@renderer/lib/env'
import { apiFetch } from '@renderer/lib/api'
import { clearBrowserActive, useMessageStream } from '@renderer/hooks/use-message-stream'
import { useUser } from '@renderer/context/user-context'
import { cn } from '@shared/lib/utils/cn'
import { useRenderTracker } from '@renderer/lib/perf'
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
  useRenderTracker('BrowserPreview')
  const { canUseAgent } = useUser()
  const isViewOnly = !canUseAgent(agentSlug)
  const [expanded, setExpanded] = useState(false)
  const [connected, setConnected] = useState(false)
  const [pageLoading, setPageLoading] = useState(false)
  const [reconnectKey, setReconnectKey] = useState(0)
  const [showCloseWarning, setShowCloseWarning] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [aspectRatio, setAspectRatio] = useState('16 / 9')
  const [overlayDismissedForId, setOverlayDismissedForId] = useState<string | null>(null)

  // Multi-tab state — Protocol: see agent-container/src/server.ts
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([])
  const [agentActiveTargetId, setAgentActiveTargetId] = useState<string | null>(null)
  const [viewingTargetId, setViewingTargetId] = useState<string | null>(null)
  const [autoFollow, setAutoFollow] = useState(true)
  const autoFollowRef = useRef(autoFollow)
  autoFollowRef.current = autoFollow

  const { pendingBrowserInputRequests } = useMessageStream(sessionId, agentSlug)
  const needsAttention = browserActive && pendingBrowserInputRequests.length > 0 && !isViewOnly
  const latestRequestId = pendingBrowserInputRequests.length > 0
    ? pendingBrowserInputRequests[pendingBrowserInputRequests.length - 1].toolUseId
    : null
  const showOverlay = needsAttention && overlayDismissedForId !== latestRequestId && expanded

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

  // Clamp position when size changes (e.g. aspect ratio update) to keep window in bounds
  useEffect(() => {
    const parent = containerRef.current?.parentElement
    if (!parent || !posRef.current) return
    const rect = parent.getBoundingClientRect()
    const currentPos = posRef.current

    let newX = currentPos.x
    let newY = currentPos.y
    let changed = false

    if (currentPos.x + size.width > rect.width) {
      newX = Math.max(0, rect.width - size.width)
      changed = true
    }
    if (currentPos.y + size.height > rect.height) {
      newY = Math.max(0, rect.height - size.height)
      changed = true
    }

    if (changed) {
      setPos({ x: newX, y: newY })
    }
  }, [size])

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
          if (blob) renderFrame(blob)

          if (data.metadata) {
            metadataRef.current = {
              deviceWidth: data.metadata.deviceWidth || 1280,
              deviceHeight: data.metadata.deviceHeight || 720,
            }
          }
        } else if (data.type === 'tab_list') {
          setTabs(data.tabs)
          setAgentActiveTargetId(data.activeTargetId)
          if (autoFollowRef.current) {
            setViewingTargetId(data.activeTargetId)
          }
        } else if (data.type === 'tab_switched') {
          setAgentActiveTargetId(data.targetId)
          setViewingTargetId(data.targetId)
        } else if (data.type === 'selection_result' && data.text) {
          navigator.clipboard.writeText(data.text).catch(() => {})
        }
      } catch {
        // Ignore parse errors for binary frames
      }
    }

    ws.onclose = () => {
      setConnected(false)
      setPageLoading(false)
      apiFetch(`/api/agents/${agentSlug}/browser/status`)
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

  // Reset overlay dismiss state when attention state ends (agent resumed)
  useEffect(() => {
    if (!needsAttention) {
      setOverlayDismissedForId(null)
    }
  }, [needsAttention])

  // Fallback when the tab the user is viewing gets closed
  useEffect(() => {
    if (viewingTargetId && tabs.length > 0 && !tabs.find(t => t.targetId === viewingTargetId)) {
      setViewingTargetId(agentActiveTargetId)
      setAutoFollow(true)
    }
  }, [tabs, viewingTargetId, agentActiveTargetId])

  // Prevent wheel events from bubbling to parent (must use native listener with passive: false)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || isViewOnly) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [isViewOnly])

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

  const sendMessage = useCallback(
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

  const pressedButtonRef = useRef<string>('none')

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = mapCoordinates(e)
      const btn = buttonName(e.button)
      pressedButtonRef.current = btn
      sendMessage({ type: 'input_mouse', eventType: 'mousePressed', x, y, button: btn, clickCount: 1, modifiers: modifierFlags(e) })
    },
    [mapCoordinates, sendMessage, buttonName, modifierFlags]
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = mapCoordinates(e)
      pressedButtonRef.current = 'none'
      sendMessage({ type: 'input_mouse', eventType: 'mouseReleased', x, y, button: buttonName(e.button), modifiers: modifierFlags(e) })
    },
    [mapCoordinates, sendMessage, buttonName, modifierFlags]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = mapCoordinates(e)
      sendMessage({ type: 'input_mouse', eventType: 'mouseMoved', x, y, button: pressedButtonRef.current, modifiers: modifierFlags(e) })
    },
    [mapCoordinates, sendMessage, modifierFlags]
  )

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      const { x, y } = mapCoordinates(e)
      sendMessage({
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
    [mapCoordinates, sendMessage, modifierFlags]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLCanvasElement>) => {
      e.preventDefault()
      const text = e.clipboardData.getData('text/plain')
      if (text) {
        sendMessage({ type: 'input_paste', text })
      }
    },
    [sendMessage]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      // Cmd+V / Ctrl+V: read host clipboard and paste into remote browser
      if (e.key === 'v' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        navigator.clipboard.readText().then(text => {
          if (text) sendMessage({ type: 'input_paste', text })
        }).catch(() => {})
        return
      }

      // Cmd+C / Ctrl+C: copy selected text from remote browser to host clipboard
      if (e.key === 'c' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        sendMessage({ type: 'get_selection' })
        return
      }

      // Cmd+X / Ctrl+X: copy selection to host clipboard, then cut in remote browser
      if (e.key === 'x' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        sendMessage({ type: 'get_selection' })
        sendMessage({ type: 'input_press', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifierFlags(e) })
        return
      }

      e.preventDefault()

      // Pure modifier keys alone: skip — they're communicated via the modifiers bitmask
      if (MODIFIER_KEYS.has(e.key)) return

      const printable = e.key.length === 1
      const hasCommandModifier = e.metaKey || e.ctrlKey

      if (printable && !hasCommandModifier) {
        // Printable characters without modifiers: send via WebSocket stream (low latency)
        sendMessage({
          type: 'input_keyboard',
          eventType: 'keyDown',
          key: e.key,
          code: e.code,
          text: e.key,
          keyCode: e.keyCode,
          modifiers: modifierFlags(e),
        })
      } else {
        // Modifier combos (Cmd+A, Ctrl+Z) and non-printable keys (Backspace, Delete, arrows):
        // Send via input_press which includes Playwright's editing commands in the CDP event
        // (e.g. 'selectAll' for Cmd+A). Goes through WebSocket so it targets the viewed tab.
        sendMessage({
          type: 'input_press',
          key: e.key,
          code: e.code,
          keyCode: e.keyCode,
          modifiers: modifierFlags(e),
        })
      }
    },
    [sendMessage, modifierFlags]
  )

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      e.preventDefault()
      // Only send keyUp for printable characters without modifiers (stream path).
      // Modifier combos and non-printable keys use input_press which sends its own keyUp.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        sendMessage({
          type: 'input_keyboard',
          eventType: 'keyUp',
          key: e.key,
          code: e.code,
          keyCode: e.keyCode,
          modifiers: modifierFlags(e),
        })
      }
    },
    [sendMessage, modifierFlags]
  )

  const handleTabClick = useCallback((targetId: string) => {
    if (targetId === viewingTargetId) return
    setAutoFollow(false)
    setViewingTargetId(targetId)
    sendMessage({ type: 'switch_tab', targetId })
  }, [viewingTargetId, sendMessage])

  const toggleAutoFollow = useCallback(() => {
    const next = !autoFollow
    setAutoFollow(next)
    sendMessage({ type: 'follow_agent', enabled: next })
    if (next && agentActiveTargetId) {
      setViewingTargetId(agentActiveTargetId)
    }
  }, [autoFollow, agentActiveTargetId, sendMessage])

  const closeBrowser = useCallback(async () => {
    setIsClosing(true)
    try {
      if (isActive) {
        // Interrupt the session first
        await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/interrupt`, {
          method: 'POST',
        })
      }
      // Close the browser
      await apiFetch(`/api/agents/${agentSlug}/browser/close`, {
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
      className={cn(
        "flex flex-col rounded-lg border bg-background shadow-lg overflow-visible",
        needsAttention && "ring-2 ring-blue-400 dark:ring-blue-500"
      )}
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
        <Globe className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 text-xs truncate">
          {needsAttention ? (
            <span className="text-blue-600 dark:text-blue-400 font-medium">Input needed</span>
          ) : (
            <>Browser{connected ? '' : ' (connecting...)'}</>
          )}
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

      {/* Tab bar — shown when any tabs are reported */}
      {expanded && tabs.length >= 1 && (
        <BrowserTabBar
          tabs={tabs}
          viewingTargetId={viewingTargetId}
          autoFollow={autoFollow}
          loading={pageLoading}
          onTabClick={handleTabClick}
          onToggleAutoFollow={toggleAutoFollow}
        />
      )}

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
            onContextMenu={(e) => e.preventDefault()}
          />
          {!connected && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <span className="text-white text-xs">Connecting to browser stream...</span>
            </div>
          )}
          {showOverlay && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm cursor-pointer z-10 transition-opacity duration-300"
              role="button"
              tabIndex={0}
              onClick={() => setOverlayDismissedForId(latestRequestId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setOverlayDismissedForId(latestRequestId)
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

if (__RENDER_TRACKING__) {
  (BrowserPreview as any).whyDidYouRender = true
}

function base64ToBlob(base64: string, mimeType: string): Blob | null {
  try {
    const byteCharacters = atob(base64)
    const byteNumbers = new Array(byteCharacters.length)
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i)
    }
    return new Blob([new Uint8Array(byteNumbers)], { type: mimeType })
  } catch {
    return null
  }
}
