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
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  completeHandshake() {
    if (this.readyState !== FakeWebSocket.CONNECTING) return
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) })
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

  it('closes the tray on browser_closed instead of asking the server again', async () => {
    const canvasRef = createRef<HTMLCanvasElement | null>()
    renderHook(() => useBrowserStream(baseOpts(canvasRef)))

    await settle()
    act(() => {
      FakeWebSocket.instances[0].completeHandshake()
    })
    await settle()

    // The user closed the browser window: the server says so, then drops us.
    act(() => {
      FakeWebSocket.instances[0].emit({ type: 'browser_closed' })
      FakeWebSocket.instances[0].close()
    })
    await settle()

    expect(clearBrowserActive).toHaveBeenCalledWith('s')
    // The browser is gone — no status probe, and nothing to reconnect to.
    expect(mockApiFetch).not.toHaveBeenCalled()
    for (let i = 0; i < 3; i++) {
      await advanceOneSecondAndOpenNewSockets()
    }
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('gives up once a socket has died before opening too many times over', async () => {
    const canvasRef = createRef<HTMLCanvasElement | null>()
    renderHook(() => useBrowserStream(baseOpts(canvasRef)))

    await settle()
    expect(FakeWebSocket.instances).toHaveLength(1)

    // Every socket dies mid-handshake while /browser/status keeps insisting the
    // browser is alive — the reconnect loop this bug produced.
    for (let i = 0; i < 12; i++) {
      const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
      act(() => {
        latest.close()
      })
      await settle()
      await act(async () => {
        vi.advanceTimersByTime(30_000)
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
    }

    // 1 initial + 5 bounded retries, then the tray is dropped.
    expect(FakeWebSocket.instances).toHaveLength(6)
    expect(clearBrowserActive).toHaveBeenCalledWith('s')
  })

  it('forgives an isolated death — the attempt budget resets once a socket opens', async () => {
    const canvasRef = createRef<HTMLCanvasElement | null>()
    renderHook(() => useBrowserStream(baseOpts(canvasRef)))

    await settle()

    // Six separate deaths, each followed by a socket that opens fine. Without
    // the reset this would exhaust the budget and close a working preview.
    for (let i = 0; i < 6; i++) {
      const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
      act(() => {
        latest.completeHandshake()
      })
      await settle()
      act(() => {
        latest.close()
      })
      await settle()
      await advanceOneSecondAndOpenNewSockets()
    }

    expect(FakeWebSocket.instances).toHaveLength(7)
    expect(clearBrowserActive).not.toHaveBeenCalled()
  })
})
