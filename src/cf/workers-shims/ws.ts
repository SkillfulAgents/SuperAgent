/**
 * The `ws` package, as SuperAgent's WebSocket clients use it, over the Workers runtime. Bundled in
 * place of `ws` (wrangler `alias`): its browser build throws on use, which leaves the webhook
 * relay's realtime connection, iMessage and Linear subscriptions dead. Supports both the native
 * style (onopen, onmessage) and ws's (on('message'), ping, terminate). `WebSocket.fromSocket` gives
 * the same API over a socket the Worker accepted.
 */
import { Buffer } from 'node:buffer'
import type { WorkerWebSocket } from 'cloudflare:workers'

type Listener = (...args: any[]) => void
type ClientOptions = { headers?: Record<string, string> }

export class WebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = WebSocket.CONNECTING
  protocol = ''
  // The runtime does not report unsent bytes.
  readonly bufferedAmount = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  private socket: WorkerWebSocket | null = null
  private readonly listeners = new Map<string, Set<Listener>>()

  /** Wraps a socket this Worker accepted (the server end of a WebSocketPair). */
  static fromSocket(socket: WorkerWebSocket, protocol = ''): WebSocket {
    const ws = new WebSocket(null)
    ws.protocol = protocol
    ws.attach(socket)
    return ws
  }

  constructor(url: string | URL | null, protocols?: string | string[] | ClientOptions, options?: ClientOptions) {
    if (url === null) return
    const named = typeof protocols === 'string' || Array.isArray(protocols) ? protocols : undefined
    // ws takes (url, options) or (url, protocols, options); protocols may be passed as undefined.
    const headers = (named || protocols === undefined ? options : (protocols as ClientOptions))?.headers ?? {}
    void this.connect(String(url), named, headers)
  }

  private async connect(url: string, protocols: string | string[] | undefined, headers: Record<string, string>): Promise<void> {
    try {
      const requestHeaders = new Headers(headers)
      requestHeaders.set('Upgrade', 'websocket')
      if (protocols) requestHeaders.set('Sec-WebSocket-Protocol', [protocols].flat().join(', '))
      const response = await fetch(url.replace(/^ws/, 'http'), { headers: requestHeaders })
      const socket = (response as Response & { webSocket?: WorkerWebSocket | null }).webSocket
      if (!socket) throw new Error(`WebSocket upgrade refused with status ${response.status}`)
      socket.accept()
      this.protocol = response.headers.get('Sec-WebSocket-Protocol') ?? ''
      this.attach(socket)
    } catch (error) {
      this.failed(error)
      this.closed(1006, '')
    }
  }

  private attach(socket: WorkerWebSocket): void {
    // Binary frames arrive as Blob otherwise, which Buffer.from can't take.
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.addEventListener('message', (event) => {
      this.onmessage?.({ data: event.data })
      const binary = typeof event.data !== 'string'
      this.emit('message', binary ? Buffer.from(event.data as ArrayBuffer) : Buffer.from(event.data as string), binary)
    })
    socket.addEventListener('close', (event) => this.closed(event.code, event.reason))
    socket.addEventListener('error', (event) => this.failed((event as ErrorEvent).error ?? new Error('WebSocket error')))
    this.readyState = WebSocket.OPEN
    this.onopen?.({ type: 'open' })
    this.emit('open')
  }

  // ws's { binary: false } sends bytes as a text frame; the runtime sends any bytes as binary.
  send(data: string | ArrayBuffer | ArrayBufferView, options?: { binary?: boolean }): void {
    if (!this.socket || this.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open')
    if (options?.binary === false && typeof data !== 'string') {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      this.socket.send(new TextDecoder().decode(bytes))
      return
    }
    this.socket.send(data as string | ArrayBuffer)
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= WebSocket.CLOSING) return
    this.readyState = WebSocket.CLOSING
    if (this.socket) this.socket.close(code, reason)
    else this.closed(code ?? 1000, reason ?? '')
  }

  terminate(): void {
    this.close(1000)
  }

  // The runtime keeps the connection alive itself and offers no ping; answer at once so a
  // caller's pong watchdog does not drop a healthy connection.
  ping(): void {
    queueMicrotask(() => this.emit('pong'))
  }

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(listener)
    return this
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped)
      listener(...args)
    }
    return this.on(event, wrapped)
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event)
    else this.listeners.clear()
    return this
  }

  addEventListener(event: string, listener: Listener): void {
    this.on(event, listener)
  }

  removeEventListener(event: string, listener: Listener): void {
    this.off(event, listener)
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener(...args)
      } catch (error) {
        console.error(`[ws] '${event}' listener threw:`, error)
      }
    }
  }

  private failed(error: unknown): void {
    this.onerror?.(error)
    if (this.listeners.get('error')?.size) this.emit('error', error)
  }

  private closed(code: number, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    this.onclose?.({ code, reason })
    this.emit('close', code, Buffer.from(reason ?? ''))
  }
}

// SuperAgent creates its upgrade servers at import; a Worker accepts sockets itself and never upgrades through one.
export class WebSocketServer {
  handleUpgrade(): never {
    throw new Error('WebSocketServer is not available in a Worker')
  }

  on(): this {
    return this
  }
}

export type RawData = Buffer
export default WebSocket
