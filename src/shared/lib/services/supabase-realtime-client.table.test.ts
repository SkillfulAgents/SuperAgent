import { describe, it, expect, beforeEach, vi } from 'vitest'

// ============================================================================
// ws mock — captures constructed sockets + sent frames; fires onopen async
// (mirrors the real handshake happening after the constructor returns).
// ============================================================================

type SentFrame = { topic: string; event: string; payload: Record<string, unknown> }

interface FakeSocket {
  url: string
  sent: SentFrame[]
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onerror: ((err: unknown) => void) | null
  onclose: (() => void) | null
}

// vi.mock factories are hoisted above imports, so the fake class + registry
// must be hoisted with them.
const { FakeWebSocket, sockets, socketBehavior } = vi.hoisted(() => {
  const sockets: FakeSocket[] = []
  const socketBehavior = { failNextConnection: false }

  class FakeWebSocket implements FakeSocket {
    static OPEN = 1
    readyState = FakeWebSocket.OPEN
    url: string
    sent: SentFrame[] = []
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: ((err: unknown) => void) | null = null
    onclose: (() => void) | null = null

    constructor(url: string) {
      this.url = url
      sockets.push(this)
      if (socketBehavior.failNextConnection) {
        socketBehavior.failNextConnection = false
        // A refused/unreachable connection errors and closes without opening.
        queueMicrotask(() => {
          this.onerror?.(new Error('connect ECONNREFUSED'))
          this.onclose?.()
        })
      } else {
        queueMicrotask(() => this.onopen?.())
      }
    }

    send(data: string): void {
      this.sent.push(JSON.parse(data) as SentFrame)
    }

    close(): void {
      this.onclose?.()
    }
  }

  return { FakeWebSocket, sockets, socketBehavior }
})

vi.mock('ws', () => ({ default: FakeWebSocket }))

import { SupabaseRealtimeClient } from './supabase-realtime-client'

const BASE_CONFIG = {
  url: 'wss://x.supabase.co/realtime/v1',
  apikey: 'anon-key',
  jwt: 'jwt-token',
  channel: 'realtime:public:webhook_events',
}

function joinFrames(socket: FakeSocket): SentFrame[] {
  return socket.sent.filter((frame) => frame.event === 'phx_join')
}

beforeEach(() => {
  sockets.length = 0
  socketBehavior.failNextConnection = false
})

describe('SupabaseRealtimeClient table parameterization', () => {
  it('defaults to webhook_events when the config has no table (legacy poll response)', async () => {
    const client = new SupabaseRealtimeClient()
    await client.connect(BASE_CONFIG, () => {})

    const [join] = joinFrames(sockets[0])
    expect(join.topic).toBe('realtime:public:webhook_events')
    const changes = (join.payload.config as {
      postgres_changes: Array<{ event: string; schema: string; table: string }>
    }).postgres_changes
    expect(changes).toEqual([{ event: 'INSERT', schema: 'public', table: 'webhook_events' }])
    expect(join.payload.access_token).toBe('jwt-token')

    client.disconnect()
  })

  it('joins the configured table when the config carries one', async () => {
    const client = new SupabaseRealtimeClient()
    await client.connect(
      { ...BASE_CONFIG, channel: 'realtime:public:notifications', table: 'notifications' },
      () => {},
    )

    const [join] = joinFrames(sockets[0])
    expect(join.topic).toBe('realtime:public:notifications')
    const changes = (join.payload.config as {
      postgres_changes: Array<{ table: string }>
    }).postgres_changes
    expect(changes[0].table).toBe('notifications')

    client.disconnect()
  })

  it('sends the access_token refresh on the configured table topic', async () => {
    const client = new SupabaseRealtimeClient()
    await client.connect({ ...BASE_CONFIG, table: 'notifications' }, () => {})

    await client.updateToken('fresh-jwt')

    const refresh = sockets[0].sent.find((frame) => frame.event === 'access_token')
    expect(refresh?.topic).toBe('realtime:public:notifications')
    expect(refresh?.payload.access_token).toBe('fresh-jwt')

    client.disconnect()
  })

  it('delivers INSERT records to the event callback', async () => {
    const client = new SupabaseRealtimeClient()
    const received: unknown[] = []
    await client.connect({ ...BASE_CONFIG, table: 'notifications' }, (r) => received.push(r))

    sockets[0].onmessage?.({
      data: JSON.stringify({
        topic: 'realtime:public:notifications',
        event: 'postgres_changes',
        payload: { data: { type: 'INSERT', record: { id: 'ntf_1', title: 'hi' } } },
      }),
    })

    expect(received).toEqual([{ id: 'ntf_1', title: 'hi' }])
    client.disconnect()
  })
})

describe('SupabaseRealtimeClient connection failure', () => {
  it('rejects connect() when the socket closes before it ever opens', async () => {
    // The close event cancels the 10s timeout, so without an explicit
    // rejection the promise would never settle and callers awaiting
    // connect() (e.g. a manager installing its JWT-refresh interval after
    // the await) would hang forever.
    socketBehavior.failNextConnection = true
    const client = new SupabaseRealtimeClient()

    await expect(client.connect(BASE_CONFIG, () => {})).rejects.toThrow(
      'WebSocket closed before connection established',
    )

    client.disconnect()
  })
})
