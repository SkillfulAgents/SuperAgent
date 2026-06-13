/**
 * Supabase Realtime Client
 *
 * Lightweight WebSocket client for subscribing to Supabase Realtime
 * postgres_changes events. Uses the `ws` package for Node.js compatibility
 * (this runs in the Electron main process, not the renderer).
 *
 * Protocol reference: https://supabase.com/docs/guides/realtime
 */

import WebSocket from 'ws'
import type { RealtimeConfig } from './webhook-events-client'

type RealtimeCallback = (payload: unknown) => void
type RealtimeRecord = {
  member_id?: unknown
  org_id?: unknown
  composio_trigger_id?: unknown
  status?: unknown
}

export class SupabaseRealtimeClient {
  private ws: WebSocket | null = null
  private heartbeatInterval: NodeJS.Timeout | null = null
  private reconnectTimeout: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private onEvent: RealtimeCallback | null = null
  private onDisconnect: (() => void) | null = null
  private config: RealtimeConfig | null = null
  private isConnected = false
  private isStopped = false
  private ref = 0

  private nextRef(): string {
    return String(++this.ref)
  }

  async connect(
    config: RealtimeConfig,
    onEvent: RealtimeCallback,
    onDisconnect?: () => void,
  ): Promise<void> {
    this.config = config
    this.onEvent = onEvent
    this.onDisconnect = onDisconnect ?? null
    this.isStopped = false
    this.reconnectAttempts = 0

    await this.doConnect()
  }

  private async doConnect(): Promise<void> {
    if (this.isStopped || !this.config) return

    const { url, apikey, jwt } = this.config

    // apikey param = Supabase project anon key (for gateway auth)
    // jwt is sent later in the phx_join payload as access_token (for RLS)
    const wsUrl = `${url}/websocket?apikey=${encodeURIComponent(apikey)}&vsn=1.0.0`
    console.log(`[SupabaseRealtime] Connecting to ${url}/websocket`)

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl)
      } catch (err) {
        reject(err)
        return
      }

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'))
        this.ws?.close()
      }, 10000)

      this.ws.onopen = () => {
        clearTimeout(timeout)
        this.isConnected = true
        this.reconnectAttempts = 0
        console.log('[SupabaseRealtime] Connected')

        // Join the realtime channel for webhook_events with RLS
        console.log(
          `[SupabaseRealtime] Joining channel realtime:public:webhook_events jwt=${describeRealtimeJwt(jwt)}`,
        )
        this.sendMessage({
          topic: `realtime:public:webhook_events`,
          event: 'phx_join',
          payload: {
            config: {
              broadcast: { self: false },
              postgres_changes: [
                {
                  event: 'INSERT',
                  schema: 'public',
                  table: 'webhook_events',
                },
              ],
            },
            access_token: jwt,
          },
          ref: this.nextRef(),
        })

        // Start heartbeat
        this.heartbeatInterval = setInterval(() => {
          this.sendMessage({
            topic: 'phoenix',
            event: 'heartbeat',
            payload: {},
            ref: this.nextRef(),
          })
        }, 30000)

        resolve()
      }

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            topic?: string
            event?: string
            payload?: unknown
            ref?: string
          }

          // Handle postgres_changes INSERT events
          if (msg.event === 'postgres_changes' && msg.payload) {
            const payload = msg.payload as { data?: { type?: string; record?: unknown } }
            if (payload.data?.type === 'INSERT' && payload.data.record) {
              const record = payload.data.record as RealtimeRecord
              console.log(
                `[SupabaseRealtime] INSERT member=${stringValue(record.member_id)} org=${stringValue(record.org_id)} trigger=${stringValue(record.composio_trigger_id)} status=${stringValue(record.status)}`,
              )
              this.onEvent?.(payload.data.record)
            }
          }
        } catch (error) {
          console.warn('[SupabaseRealtime] Failed to parse realtime message:', error)
        }
      }

      this.ws.onerror = (err) => {
        const message = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err)
        console.error('[SupabaseRealtime] WebSocket error:', message)
      }

      this.ws.onclose = () => {
        clearTimeout(timeout)
        this.isConnected = false
        this.stopHeartbeat()
        console.log('[SupabaseRealtime] Disconnected')

        if (!this.isStopped) {
          this.scheduleReconnect()
        }

        this.onDisconnect?.()
      }
    })
  }

  private sendMessage(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  private scheduleReconnect(): void {
    if (this.isStopped || this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[SupabaseRealtime] Max reconnect attempts reached')
      return
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++

    console.log(`[SupabaseRealtime] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    this.reconnectTimeout = setTimeout(() => {
      this.doConnect().catch((err) => {
        console.error('[SupabaseRealtime] Reconnect failed:', err)
      })
    }, delay)
  }

  disconnect(): void {
    this.isStopped = true
    this.stopHeartbeat()

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.ws) {
      this.ws.onclose = null // Prevent reconnect
      this.ws.close()
      this.ws = null
    }

    this.isConnected = false
    console.log('[SupabaseRealtime] Stopped')
  }

  isActive(): boolean {
    return this.isConnected && !this.isStopped
  }

  /**
   * Update the JWT used for authentication.
   * Reconnects with the new token.
   */
  async updateToken(jwt: string): Promise<void> {
    if (!this.config) return
    this.config = { ...this.config, jwt }
    console.log(`[SupabaseRealtime] Updating access_token jwt=${describeRealtimeJwt(jwt)}`)

    // Send access_token update if connected
    if (this.isConnected) {
      this.sendMessage({
        topic: `realtime:public:webhook_events`,
        event: 'access_token',
        payload: { access_token: jwt },
        ref: this.nextRef(),
      })
    }
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'none'
}

function describeRealtimeJwt(jwt: string): string {
  const segments = jwt.split('.')
  if (segments.length !== 3) return 'opaque'
  try {
    const payload = JSON.parse(decodeBase64Url(segments[1])) as Record<string, unknown>
    return `sub=${stringValue(payload.sub)} member=${stringValue(payload.member_id)} org=${stringValue(payload.org_id)} exp=${typeof payload.exp === 'number' ? payload.exp : 'none'}`
  } catch {
    return 'unparseable'
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4)
  return Buffer.from(padded, 'base64').toString('utf8')
}
