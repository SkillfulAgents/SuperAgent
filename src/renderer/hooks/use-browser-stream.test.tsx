// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef, type RefObject } from 'react'
import { renderHook, act } from '@testing-library/react'
import { useBrowserStream } from './use-browser-stream'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))
vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: () => 'http://localhost:47891',
}))
const clearBrowserActive = vi.fn()
vi.mock('@renderer/hooks/use-message-stream', () => ({
  clearBrowserActive: (...args: unknown[]) => clearBrowserActive(...args),
}))
vi.mock('@renderer/components/messages/use-pending-requests', () => ({
  usePendingBrowserInputRequests: () => ({ requests: [], dismiss: vi.fn() }),
}))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canUseAgent: () => true }),
}))

/**
 * Models the two WebSocket properties this bug depends on:
 *  - the close event is delivered on a later task, never synchronously from close()
 *  - close() on an already-CLOSED socket is a no-op and fires nothing
 */
class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  sent: string[] = []

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  completeHandshake() {
    if (this.readyState !== FakeWebSocket.CONNECTING) return
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    queueMicrotask(() => this.onclose?.())
  }
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function advanceOneSecondAndOpenNewSockets() {
  await act(async () => {
    vi.advanceTimersByTime(1000)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  act(() => {
    FakeWebSocket.instances.forEach((ws) => ws.completeHandshake())
  })
  await settle()
}

function baseOpts(canvasRef: RefObject<HTMLCanvasElement | null>) {
  return {
    agentSlug: 'a',
    sessionId: 's',
    browserActive: true,
    isConnected: true,
    isActive: true,
    canvasRef,
  }
}

describe('useBrowserStream reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    mockApiFetch.mockResolvedValue({
      json: () => Promise.resolve({ active: true, sessionId: 's' }),
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not reconnect-storm after an effect re-run while the socket is live', async () => {
    // Seed the way the real app does: force an effect re-run while a live socket
    // exists (fresh canvasRef → new renderFrame identity → effect deps change).
    // Do not seed via StrictMode with browserActive already true — that is not
    // how the tray mounts.
    const firstRef = createRef<HTMLCanvasElement | null>()
    const { rerender } = renderHook(
      ({ canvasRef }) => useBrowserStream(baseOpts(canvasRef)),
      { initialProps: { canvasRef: firstRef } },
    )

    await settle()
    expect(FakeWebSocket.instances).toHaveLength(1)
    act(() => {
      FakeWebSocket.instances[0].completeHandshake()
    })
    await settle()

    const secondRef = createRef<HTMLCanvasElement | null>()
    rerender({ canvasRef: secondRef })
    await settle()
    act(() => {
      FakeWebSocket.instances.forEach((ws) => ws.completeHandshake())
    })
    await settle()

    // One legitimate replacement from the canvasRef-driven effect re-run.
    expect(FakeWebSocket.instances).toHaveLength(2)
    const afterRerun = FakeWebSocket.instances.length

    for (let i = 0; i < 5; i++) {
      await advanceOneSecondAndOpenNewSockets()
    }

    expect(FakeWebSocket.instances.length).toBe(afterRerun)
  })

  it('reconnects once when the current socket dies and the browser is still active', async () => {
    const canvasRef = createRef<HTMLCanvasElement | null>()
    renderHook(() => useBrowserStream(baseOpts(canvasRef)))

    await settle()
    expect(FakeWebSocket.instances).toHaveLength(1)
    act(() => {
      FakeWebSocket.instances[0].completeHandshake()
    })
    await settle()

    // The server drops the socket the hook is currently using.
    act(() => {
      FakeWebSocket.instances[0].close()
    })
    await settle()

    // Status fetch says still active → reconnect scheduled for 1s later.
    await advanceOneSecondAndOpenNewSockets()

    expect(FakeWebSocket.instances).toHaveLength(2)

    // No further growth — genuine death reconnects once, then stops.
    for (let i = 0; i < 3; i++) {
      await advanceOneSecondAndOpenNewSockets()
    }
    expect(FakeWebSocket.instances).toHaveLength(2)

    // The replacement must reconnect too. Everything above still passes if the
    // storm is stopped by disabling reconnects after the first teardown, since
    // the first death happens before any teardown has run. Killing the socket
    // that a teardown produced is what tells the two apart.
    act(() => {
      FakeWebSocket.instances[1].close()
    })
    await settle()
    await advanceOneSecondAndOpenNewSockets()

    expect(FakeWebSocket.instances).toHaveLength(3)
  })
})

describe('useBrowserStream width toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    mockApiFetch.mockResolvedValue({
      json: () => Promise.resolve({ active: true, sessionId: 's' }),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // The next click derives from the local value, so if only the container's
  // report could move it, one dropped or late report would latch the toggle:
  // every later click re-sends the value that is already in effect.
  it('asks for the opposite mode on the second click even with no report back', async () => {
    const canvasRef = createRef<HTMLCanvasElement | null>()
    const { result } = renderHook(() => useBrowserStream(baseOpts(canvasRef)))
    await settle()
    act(() => {
      FakeWebSocket.instances[0].completeHandshake()
    })
    await settle()
    const ws = FakeWebSocket.instances[0]

    act(() => result.current.toggleDesktopWidth())
    await settle()
    act(() => result.current.toggleDesktopWidth())
    await settle()

    const widthAsks = ws.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === 'set_desktop_width')
    expect(widthAsks).toEqual([
      { type: 'set_desktop_width', enabled: true },
      { type: 'set_desktop_width', enabled: false },
    ])
  })

  // Two clicks in one frame share a render closure. Deriving the next mode from
  // state would send `true` twice and the second click would do nothing.
  it('alternates when two clicks land before a re-render', async () => {
    const canvasRef = createRef<HTMLCanvasElement | null>()
    const { result } = renderHook(() => useBrowserStream(baseOpts(canvasRef)))
    await settle()
    act(() => {
      FakeWebSocket.instances[0].completeHandshake()
    })
    await settle()
    const ws = FakeWebSocket.instances[0]

    act(() => {
      result.current.toggleDesktopWidth()
      result.current.toggleDesktopWidth()
    })
    await settle()

    const widthAsks = ws.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === 'set_desktop_width')
      .map((m) => m.enabled)
    expect(widthAsks).toEqual([true, false])
  })

  // A click can land in the window between the socket closing and the button
  // re-rendering as disabled. Showing a mode we never managed to ask for is worse
  // than ignoring the click.
  it('does not move the toggle when the socket is not open', async () => {
    const canvasRef = createRef<HTMLCanvasElement | null>()
    const { result } = renderHook(() => useBrowserStream(baseOpts(canvasRef)))
    await settle()
    act(() => {
      FakeWebSocket.instances[0].completeHandshake()
    })
    await settle()

    FakeWebSocket.instances[0].readyState = FakeWebSocket.CLOSED
    act(() => result.current.toggleDesktopWidth())
    await settle()

    expect(result.current.desktopWidth).toBe(false)
  })

  it('takes the container report as authoritative over the local guess', async () => {
    const canvasRef = createRef<HTMLCanvasElement | null>()
    const { result } = renderHook(() => useBrowserStream(baseOpts(canvasRef)))
    await settle()
    act(() => {
      FakeWebSocket.instances[0].completeHandshake()
    })
    await settle()

    act(() => result.current.toggleDesktopWidth())
    await settle()
    expect(result.current.desktopWidth).toBe(true)

    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({ type: 'viewport_mode', desktopWidth: false }),
      })
    })
    await settle()

    expect(result.current.desktopWidth).toBe(false)
  })
})
