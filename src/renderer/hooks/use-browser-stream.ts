import { useState, useEffect, useRef, useCallback } from 'react'
import type { BrowserTabInfo } from '@renderer/components/browser/browser-tab-bar'
import { getApiBaseUrl } from '@renderer/lib/env'
import { apiFetch } from '@renderer/lib/api'
import { clearBrowserActive, useMessageStream } from '@renderer/hooks/use-message-stream'
import { useUser } from '@renderer/context/user-context'

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

interface UseBrowserStreamOptions {
  agentSlug: string
  sessionId: string
  browserActive: boolean
  isConnected: boolean
  isActive: boolean
  canvasRef: React.RefObject<HTMLCanvasElement | null>
}

export function useBrowserStream({
  agentSlug,
  sessionId,
  browserActive,
  isConnected,
  isActive,
  canvasRef,
}: UseBrowserStreamOptions) {
  const { canUseAgent } = useUser()
  const isViewOnly = !canUseAgent(agentSlug)

  const [connected, setConnected] = useState(false)
  const [pageLoading, setPageLoading] = useState(false)
  const [reconnectKey, setReconnectKey] = useState(0)
  const [showCloseWarning, setShowCloseWarning] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [aspectRatio, setAspectRatio] = useState('16 / 9')
  const [overlayDismissedForId, setOverlayDismissedForId] = useState<string | null>(null)

  // Multi-tab state
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([])
  const [agentActiveTargetId, setAgentActiveTargetId] = useState<string | null>(null)
  const [viewingTargetId, setViewingTargetId] = useState<string | null>(null)
  const [autoFollow, setAutoFollow] = useState(true)
  const autoFollowRef = useRef(autoFollow)
  autoFollowRef.current = autoFollow

  // Lifecycle refs for cleanup
  const isMountedRef = useRef(true)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { pendingBrowserInputRequests } = useMessageStream(sessionId, agentSlug)
  const needsAttention = browserActive && pendingBrowserInputRequests.length > 0 && !isViewOnly
  const latestRequestId = pendingBrowserInputRequests.length > 0
    ? pendingBrowserInputRequests[pendingBrowserInputRequests.length - 1].toolUseId
    : null
  const showOverlay = needsAttention && overlayDismissedForId !== latestRequestId

  const wsRef = useRef<WebSocket | null>(null)
  const metadataRef = useRef<{ deviceWidth: number; deviceHeight: number }>({
    deviceWidth: 1280,
    deviceHeight: 720,
  })

  // Track window resize to skip expensive processing during resize
  const isResizingWindowRef = useRef(false)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const onResize = () => {
      isResizingWindowRef.current = true
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        isResizingWindowRef.current = false
      }, 200)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
    }
  }, [])

  // --- Frame rendering (rAF-throttled, off-thread decode) ---
  const pendingBlobRef = useRef<Blob | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)

  const renderFrame = useCallback((blob: Blob) => {
    pendingBlobRef.current = blob

    // Schedule render on next animation frame (coalesces multiple WS frames into one paint)
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null
        const latestBlob = pendingBlobRef.current
        pendingBlobRef.current = null
        if (!latestBlob) return

        const canvas = canvasRef.current
        if (!canvas) return
        // Cache context — desynchronized skips the compositor for lower latency
        if (!ctxRef.current) {
          ctxRef.current = canvas.getContext('2d', { desynchronized: true })
        }
        const ctx = ctxRef.current
        if (!ctx) return

        // Decode image off the main thread
        createImageBitmap(latestBlob).then((bitmap) => {
          const needsResize = canvas.width !== bitmap.width || canvas.height !== bitmap.height
          if (needsResize) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
            const newRatio = `${bitmap.width} / ${bitmap.height}`
            setAspectRatio(prev => prev === newRatio ? prev : newRatio)
          }
          ctx.drawImage(bitmap, 0, 0)
          bitmap.close()
        }).catch(() => {
          // Ignore decode errors (corrupt frame)
        })
      })
    }
  }, [canvasRef])

  // --- WebSocket connection ---
  useEffect(() => {
    if (!browserActive || !isConnected) {
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
        setConnected(false)
      }
      return
    }

    isMountedRef.current = true
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
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
        // During window resize, skip frame rendering entirely to keep resize smooth
        const resizing = isResizingWindowRef.current

        if (event.data instanceof Blob) {
          if (!resizing) renderFrame(event.data)
          return
        }

        const data = typeof event.data === 'string' ? JSON.parse(event.data) : null
        if (!data) return

        // Metadata updates are cheap (ref only, no re-render)
        if (data.type === 'metadata') {
          metadataRef.current = {
            deviceWidth: data.deviceWidth || 1280,
            deviceHeight: data.deviceHeight || 720,
          }
          return
        }

        if (data.type === 'page_loading') {
          setPageLoading(prev => prev === data.loading ? prev : data.loading)
        } else if (data.type === 'frame' && data.data) {
          if (!resizing) {
            const blob = base64ToBlob(data.data, 'image/jpeg')
            if (blob) renderFrame(blob)
          }

          if (data.metadata) {
            metadataRef.current = {
              deviceWidth: data.metadata.deviceWidth || 1280,
              deviceHeight: data.metadata.deviceHeight || 720,
            }
          }
        } else if (data.type === 'tab_list') {
          setTabs(prev => {
            if (prev.length === data.tabs.length && prev.every((t: BrowserTabInfo, i: number) =>
              t.targetId === data.tabs[i].targetId && t.title === data.tabs[i].title &&
              t.url === data.tabs[i].url && t.active === data.tabs[i].active
            )) return prev
            return data.tabs
          })
          setAgentActiveTargetId(prev => prev === data.activeTargetId ? prev : data.activeTargetId)
          if (autoFollowRef.current) {
            setViewingTargetId(prev => prev === data.activeTargetId ? prev : data.activeTargetId)
          }
        } else if (data.type === 'tab_switched') {
          setAgentActiveTargetId(prev => prev === data.targetId ? prev : data.targetId)
          setViewingTargetId(prev => prev === data.targetId ? prev : data.targetId)
        } else if (data.type === 'selection_result' && data.text) {
          navigator.clipboard.writeText(data.text).catch(() => {})
        }
      } catch {
        // Ignore parse errors for binary frames
      }
    }

    ws.onclose = () => {
      if (!isMountedRef.current) return
      setConnected(false)
      setPageLoading(false)
      apiFetch(`/api/agents/${agentSlug}/browser/status`)
        .then((res) => res.json())
        .then((status: { active?: boolean; sessionId?: string }) => {
          if (!isMountedRef.current) return
          if (!status.active || status.sessionId !== sessionId) {
            clearBrowserActive(sessionId)
          } else {
            reconnectTimerRef.current = setTimeout(() => setReconnectKey(k => k + 1), 1000)
          }
        })
        .catch(() => {
          if (isMountedRef.current) clearBrowserActive(sessionId)
        })
    }

    ws.onerror = () => {
      if (isMountedRef.current) setConnected(false)
    }

    return () => {
      isMountedRef.current = false
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      pendingBlobRef.current = null
      ctxRef.current = null
      ws.close()
      wsRef.current = null
      setConnected(false)
    }
  }, [browserActive, isConnected, agentSlug, sessionId, renderFrame, reconnectKey])

  // Reset overlay dismiss state when attention state ends
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

  // Prevent wheel events from bubbling (must use native listener with passive: false)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || isViewOnly) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [canvasRef, isViewOnly])

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
    [canvasRef]
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
      if (e.key === 'v' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        navigator.clipboard.readText().then(text => {
          if (text) sendMessage({ type: 'input_paste', text })
        }).catch(() => {})
        return
      }

      if (e.key === 'c' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        sendMessage({ type: 'get_selection' })
        return
      }

      if (e.key === 'x' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        sendMessage({ type: 'get_selection' })
        sendMessage({ type: 'input_press', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifierFlags(e) })
        return
      }

      e.preventDefault()

      if (MODIFIER_KEYS.has(e.key)) return

      const printable = e.key.length === 1
      const hasCommandModifier = e.metaKey || e.ctrlKey

      if (printable && !hasCommandModifier) {
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

  const handleCloseTab = useCallback((targetId: string) => {
    sendMessage({ type: 'close_tab', targetId })
  }, [sendMessage])

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
        await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/interrupt`, {
          method: 'POST',
        })
      }
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

  const dismissOverlay = useCallback(() => {
    setOverlayDismissedForId(latestRequestId)
  }, [latestRequestId])

  return {
    isViewOnly,
    connected,
    pageLoading,
    aspectRatio,
    tabs,
    viewingTargetId,
    autoFollow,
    needsAttention,
    showOverlay,
    pendingBrowserInputRequests,
    latestRequestId,
    // Canvas event handlers
    handleMouseDown,
    handleMouseUp,
    handleMouseMove,
    handleWheel,
    handleKeyDown,
    handleKeyUp,
    handlePaste,
    // Tab handlers
    handleTabClick,
    handleCloseTab,
    toggleAutoFollow,
    // Close handlers
    closeBrowser,
    handleCloseClick,
    showCloseWarning,
    setShowCloseWarning,
    isClosing,
    // Overlay
    dismissOverlay,
  }
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
