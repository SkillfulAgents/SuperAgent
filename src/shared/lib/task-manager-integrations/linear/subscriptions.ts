import WebSocket from 'ws'
import type { LinearClient } from './client'
import { directFrameSchema, directWakeResponseSchema } from './direct-schema'
import { DIRECT_SUBSCRIPTIONS } from './direct-queries'

interface Options {
  client: LinearClient
  appUserId: string
  isTracked: (id: string) => boolean
  onWake: () => void
  onError: (error: Error) => void
  onUnavailable?: () => void
}
/** One authenticated socket per Linear app identity. The bearer goes in the
 * upgrade header, as verified against Linear's public subscription endpoint. */
export class LinearSubscriptions {
  private socket?: WebSocket
  private timer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private registration?: ReturnType<typeof setTimeout>
  private refresh?: ReturnType<typeof setTimeout>
  private stopped = true
  private generation = 0
  private failures = 0
  private lastPong = 0
  private ready = false
  private unavailableOperations = new Set<string>()
  constructor(private readonly options: Options) {}
  isReady(): boolean { return this.ready }
  start(): void { if (!this.stopped) return; this.stopped = false; void this.connect() }
  stop(): void {
    this.stopped = true; this.generation++; this.ready = false
    clearTimeout(this.timer); clearTimeout(this.refresh); clearTimeout(this.registration); clearInterval(this.heartbeat)
    this.socket?.terminate(); this.socket = undefined
  }
  private async connect(): Promise<void> {
    if (this.stopped) return
    const generation = ++this.generation
    try {
      const authorization = await this.options.client.authorization()
      if (this.stopped || generation !== this.generation) return
      const socket = new WebSocket('wss://api.linear.app/graphql', 'graphql-transport-ws', {
        headers: { Authorization: `Bearer ${authorization.accessToken}` }, handshakeTimeout: 10000,
        maxPayload: 1024 * 1024,
      })
      this.socket = socket
      const acknowledgementTimeout = setTimeout(() => socket.terminate(), 15000)
      acknowledgementTimeout.unref()
      let acknowledged = false
      const startedAt = Date.now()
      socket.on('open', () => socket.send(JSON.stringify({ type: 'connection_init' })))
      socket.on('message', raw => {
        if (this.stopped || generation !== this.generation) return
        try {
          const frame = directFrameSchema.parse(JSON.parse(String(raw)))
          if (frame.type === 'connection_ack' && !acknowledged) {
            acknowledged = true
            clearTimeout(acknowledgementTimeout)
            this.lastPong = Date.now()
            const operations = Object.entries(DIRECT_SUBSCRIPTIONS).filter(([id]) => !this.unavailableOperations.has(id))
            // Linear closed burst registration with code 4003 in live testing.
            // Pace registrations and reconcile once the whole set is installed.
            const subscribeNext = () => {
              if (this.stopped || generation !== this.generation || socket.readyState !== WebSocket.OPEN) return
              const operation = operations.shift()
              if (operation) {
                const [id, query] = operation
                socket.send(JSON.stringify({ id, type: 'subscribe', payload: { query } }))
              }
              if (operations.length) {
                this.registration = setTimeout(subscribeNext, 1500)
                this.registration.unref()
              } else {
                this.ready = this.unavailableOperations.size === 0
                this.options.onWake()
              }
            }
            subscribeNext()
            this.heartbeat = setInterval(() => {
              if (Date.now() - this.lastPong > 60000) { socket.terminate(); return }
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
            }, 20000)
            this.heartbeat.unref()
            this.refresh = setTimeout(() => socket.close(1000), Math.min(86400000, Math.max(1000, authorization.expiresAt - Date.now() - 60000)))
            this.refresh.unref()
          } else if (frame.type === 'pong') this.lastPong = Date.now()
          else if (frame.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
          else if (frame.type === 'error' || frame.type === 'complete') {
            if (frame.id && frame.id in DIRECT_SUBSCRIPTIONS) this.operationUnavailable(frame.id)
            else {
              this.options.onError(new Error('Linear subscription ended; recovering through direct API queries'))
              socket.close(1000)
            }
          } else if (frame.type === 'next' && frame.id) {
            const result = directWakeResponseSchema.parse(frame.payload)
            if (result.errors?.length) { this.operationUnavailable(frame.id); return }
            const data = result.data?.[frame.id]
            if (data && (frame.id.startsWith('notification') || (frame.id === 'userUpdated' ? data.id === this.options.appUserId : this.options.isTracked(data.issue?.id ?? data.id ?? '')))) this.options.onWake()
          }
        } catch {
          this.options.onError(new Error('Linear subscription returned an invalid response'))
          socket.close(1000)
        }
      })
      socket.on('error', () => this.options.onError(new Error('Linear subscription connection failed')))
      socket.on('close', code => {
        clearTimeout(acknowledgementTimeout)
        if (generation !== this.generation) return
        clearTimeout(this.refresh); clearTimeout(this.registration); clearInterval(this.heartbeat)
        this.ready = false; this.socket = undefined
        if (!this.stopped) {
          this.options.onUnavailable?.()
          if (code !== 1000) this.options.onError(new Error(`Linear subscription disconnected (${code}); recovering through direct API queries`))
          if (Date.now() - startedAt >= 60000) this.failures = 0
          this.reconnect()
        }
      })
    } catch {
      if (this.stopped || generation !== this.generation) return
      this.options.onUnavailable?.()
      this.options.onError(new Error('Could not authenticate the Linear subscription connection'))
      this.reconnect()
    }
  }
  private operationUnavailable(id: string): void {
    this.ready = false
    if (this.unavailableOperations.has(id)) return
    this.unavailableOperations.add(id)
    this.options.onUnavailable?.()
    this.options.onError(new Error(`Linear subscription ${id} is unavailable; using direct API polling for this operation`))
  }
  private reconnect(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.connect() }, Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5)))
    this.timer.unref()
  }
}
