import { useState, useEffect, useRef, useCallback, useReducer } from 'react'
import {
  BROWSER_STREAM_SCALES,
  parseBrowserStreamScale,
  H264_FRAME_HEADER_BYTES,
  H264_STREAM_CODEC,
  isH264FrameMessage,
  isH264KeyFrameMessage,
  type BrowserKeyframeRequest,
  type BrowserStreamScale,
  type BrowserTabInfo,
  type BrowserNavigateAction,
} from '@shared/lib/browser-stream-protocol'
import { browserViewReducer, initialBrowserView } from '@renderer/lib/browser-stream-state'
import { getApiBaseUrl } from '@renderer/lib/env'
import { apiFetch } from '@renderer/lib/api'
import { clearBrowserActive } from '@renderer/hooks/use-message-stream'
import { usePendingBrowserInputRequests } from '@shared/lib/tools/requests/use-pending-requests'
import { useUser } from '@renderer/context/user-context'

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

export type NavigateAction = BrowserNavigateAction

// Reconnect backoff for a socket that keeps dying before it opens.
const RECONNECT_BASE_MS = 1000
const MAX_RECONNECT_DELAY_MS = 8000
const MAX_FAILED_RECONNECTS = 5

const STREAM_SCALE_STORAGE_KEY = 'superagent-browser-stream-scale'

// Chromium builds without proprietary codecs (e.g. Playwright's) have VideoDecoder but no H.264.
let h264Support: Promise<boolean> | null = null
function probeH264Support(): Promise<boolean> {
  h264Support ??= VideoDecoder.isConfigSupported({ codec: 'avc1.42E033' })
    .then((result) => result.supported === true, () => false)
  return h264Support
}

/** `avc1.PPCCLL` (profile, constraint flags, level) from the SPS that every keyframe carries. */
function h264CodecString(frame: Uint8Array): string | null {
  for (let i = 0; i + 6 < frame.length; i++) {
    if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 1 && (frame[i + 3] & 0x1f) === 7) {
      return `avc1.${[frame[i + 4], frame[i + 5], frame[i + 6]].map((b) => b.toString(16).padStart(2, '0')).join('')}`
    }
  }
  return null
}

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
  const [streamScale, setStreamScale] = useState<BrowserStreamScale>(
    () => parseBrowserStreamScale(localStorage.getItem(STREAM_SCALE_STORAGE_KEY)),
  )
  const cycleStreamScale = useCallback(() => {
    setStreamScale((current) => {
      const next = BROWSER_STREAM_SCALES[(BROWSER_STREAM_SCALES.indexOf(current) + 1) % BROWSER_STREAM_SCALES.length]
      localStorage.setItem(STREAM_SCALE_STORAGE_KEY, String(next))
      return next
    })
  }, [])
  // null while the H.264 probe runs; the stream connects once it is known.
  const [canDecodeH264, setCanDecodeH264] = useState<boolean | null>(
    () => (typeof VideoDecoder === 'undefined' ? false : null),
  )
  useEffect(() => {
    if (canDecodeH264 !== null) return
    let cancelled = false
    probeH264Support().then((supported) => { if (!cancelled) setCanDecodeH264(supported) })
    return () => { cancelled = true }
  }, [canDecodeH264])
  const [overlayDismissedForId, setOverlayDismissedForId] = useState<string | null>(null)

  // Multi-tab state
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([])
  const [agentActiveTargetId, setAgentActiveTargetId] = useState<string | null>(null)
  const [{ targetId: viewingTargetId, history }, dispatchView] = useReducer(browserViewReducer, initialBrowserView)
  const setViewingTargetId = useCallback((targetId: string | null) => dispatchView({ type: 'view', targetId }), [])
  const [autoFollow, setAutoFollow] = useState(true)
  const autoFollowRef = useRef(autoFollow)
  autoFollowRef.current = autoFollow

  // Lifecycle refs for cleanup
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Sockets that died before ever opening, back to back. The stream endpoint
  // answering "still active" is not proof it can serve us — give up rather than
  // reconnect at 1Hz forever behind a preview that will never paint.
  const failedReconnectsRef = useRef(0)

  const { requests: pendingBrowserInputRequests, dismiss: dismissBrowserInputRequest } =
    usePendingBrowserInputRequests(sessionId, agentSlug)
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

  const paint = useCallback((image: ImageBitmap | VideoFrame, width: number, height: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Cache context — desynchronized skips the compositor for lower latency
    if (!ctxRef.current) {
      ctxRef.current = canvas.getContext('2d', { desynchronized: true })
    }
    const ctx = ctxRef.current
    if (!ctx) return
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      const newRatio = `${width} / ${height}`
      setAspectRatio(prev => prev === newRatio ? prev : newRatio)
    }
    ctx.drawImage(image, 0, 0)
  }, [canvasRef])

  // --- H.264 frames (when the container encodes video) ---
  const decoderRef = useRef<VideoDecoder | null>(null)
  const h264TimestampRef = useRef(0)

  const decoderCodecRef = useRef<string | null>(null)

  const decodeH264 = useCallback((bytes: Uint8Array, requestKeyframe: () => void) => {
    const keyFrame = isH264KeyFrameMessage(bytes)
    const data = bytes.subarray(H264_FRAME_HEADER_BYTES)
    let decoder = decoderRef.current
    if (keyFrame) {
      const codec = h264CodecString(data)
      if (codec && (!decoder || decoder.state === 'closed' || decoderCodecRef.current !== codec)) {
        if (!decoder || decoder.state === 'closed') {
          decoder = new VideoDecoder({
            output: (frame) => {
              // Every frame must still be decoded during a window resize; only painting is skipped.
              if (!isResizingWindowRef.current) paint(frame, frame.displayWidth, frame.displayHeight)
              frame.close()
            },
            error: () => {
              decoderRef.current = null
              requestKeyframe()
            },
          })
          decoderRef.current = decoder
        }
        // A new size can change the level, so each keyframe's own SPS decides the configuration.
        decoder.configure({ codec, optimizeForLatency: true })
        decoderCodecRef.current = codec
      }
    }
    // A delta frame can't start a stream; the next keyframe will.
    if (!decoder || decoder.state !== 'configured') return
    decoder.decode(new EncodedVideoChunk({
      type: keyFrame ? 'key' : 'delta',
      timestamp: h264TimestampRef.current++,
      data,
    }))
  }, [paint])

  const renderFrame = useCallback((blob: Blob) => {
    pendingBlobRef.current = blob

    // Schedule render on next animation frame (coalesces multiple WS frames into one paint)
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null
        const latestBlob = pendingBlobRef.current
        pendingBlobRef.current = null
        if (!latestBlob) return

        // Decode image off the main thread
        createImageBitmap(latestBlob).then((bitmap) => {
          paint(bitmap, bitmap.width, bitmap.height)
          bitmap.close()
        }).catch(() => {
          // Ignore decode errors (corrupt frame)
        })
      })
    }
  }, [paint])

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

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    if (canDecodeH264 === null) return

    const baseUrl = getApiBaseUrl()
    const wsProtocol = baseUrl.startsWith('https') || window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsHost = baseUrl ? baseUrl.replace(/^https?:\/\//, '') : window.location.host
    const query = new URLSearchParams()
    if (canDecodeH264) query.set('codec', H264_STREAM_CODEC)
    if (streamScale !== 1) query.set('scale', String(streamScale))
    const wsUrl = `${wsProtocol}://${wsHost}/api/agents/${agentSlug}/browser/stream${query.size ? `?${query}` : ''}`

    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    const requestKeyframe = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'keyframe_request' } satisfies BrowserKeyframeRequest))
      }
    }
    // Set by a browser_closed frame: the server has already dropped its browser
    // state, so the close that follows needs no status check and no retry.
    let browserGone = false

    ws.onopen = () => {
      failedReconnectsRef.current = 0
      dispatchView({ type: 'reset' })
      setConnected(true)
    }

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return
      try {
        // During window resize, skip frame rendering entirely to keep resize smooth
        const resizing = isResizingWindowRef.current

        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data)
          if (isH264FrameMessage(bytes)) decodeH264(bytes, requestKeyframe)
          else if (!resizing) renderFrame(new Blob([bytes], { type: 'image/jpeg' }))
          return
        }
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
        } else if (data.type === 'history_state') {
          dispatchView({
            type: 'history',
            targetId: typeof data.targetId === 'string' ? data.targetId : undefined,
            history: {
              canGoBack: data.canGoBack === true,
              canGoForward: data.canGoForward === true,
              url: typeof data.url === 'string' ? data.url : '',
            },
          })
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
              t.url === data.tabs[i].url && t.active === data.tabs[i].active &&
              t.faviconUrl === data.tabs[i].faviconUrl
            )) return prev
            return data.tabs
          })
          setAgentActiveTargetId(prev => prev === data.activeTargetId ? prev : data.activeTargetId)
          if (autoFollowRef.current) {
            setViewingTargetId(data.activeTargetId)
          }
        } else if (data.type === 'tab_switched') {
          setAgentActiveTargetId(prev => prev === data.targetId ? prev : data.targetId)
          setViewingTargetId(data.targetId)
        } else if (data.type === 'selection_result' && data.text) {
          navigator.clipboard.writeText(data.text).catch(() => {})
        } else if (data.type === 'browser_closed') {
          // The user closed the browser window. Drop the tray now rather than
          // waiting on the status round-trip the socket close would trigger.
          browserGone = true
          clearBrowserActive(sessionId)
        }
      } catch {
        // Ignore parse errors for binary frames
      }
    }

    ws.onclose = () => {
      if (wsRef.current !== ws) return
      setConnected(false)
      setPageLoading(false)
      dispatchView({ type: 'reset' })
      if (browserGone) {
        clearBrowserActive(sessionId)
        return
      }
      apiFetch(`/api/agents/${agentSlug}/browser/status`)
        .then((res) => res.json())
        .then((status: { active?: boolean; sessionId?: string }) => {
          if (wsRef.current !== ws) return
          if (!status.active || status.sessionId !== sessionId) {
            clearBrowserActive(sessionId)
          } else if (failedReconnectsRef.current >= MAX_FAILED_RECONNECTS) {
            clearBrowserActive(sessionId)
          } else {
            const attempt = failedReconnectsRef.current++
            reconnectTimerRef.current = setTimeout(
              () => setReconnectKey(k => k + 1),
              Math.min(RECONNECT_BASE_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS),
            )
          }
        })
        .catch(() => {
          if (wsRef.current === ws) clearBrowserActive(sessionId)
        })
    }

    ws.onerror = () => {
      if (wsRef.current === ws) setConnected(false)
    }

    return () => {
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
      if (decoderRef.current && decoderRef.current.state !== 'closed') decoderRef.current.close()
      decoderRef.current = null
      decoderCodecRef.current = null
      ws.close()
      wsRef.current = null
      setConnected(false)
    }
  }, [browserActive, isConnected, agentSlug, sessionId, renderFrame, decodeH264, reconnectKey, setViewingTargetId, streamScale, canDecodeH264])

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
  }, [tabs, viewingTargetId, agentActiveTargetId, setViewingTargetId])

  // Prevent default scroll behavior (must use native listener with passive: false
  // so preventDefault() works; React's onWheel is passive and can't prevent scrolling)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || isViewOnly) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
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
  }, [viewingTargetId, sendMessage, setViewingTargetId])

  /** Back / forward / reload on the tab being viewed. */
  const navigate = useCallback((action: NavigateAction) => {
    if (!isViewOnly) sendMessage({ type: 'navigate', action })
  }, [sendMessage, isViewOnly])

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
  }, [autoFollow, agentActiveTargetId, sendMessage, setViewingTargetId])

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
    streamScale,
    cycleStreamScale,
    tabs,
    viewingTargetId,
    autoFollow,
    needsAttention,
    showOverlay,
    pendingBrowserInputRequests,
    dismissBrowserInputRequest,
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
    // History
    canGoBack: history.canGoBack,
    canGoForward: history.canGoForward,
    pageUrl: history.url,
    navigate,
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
