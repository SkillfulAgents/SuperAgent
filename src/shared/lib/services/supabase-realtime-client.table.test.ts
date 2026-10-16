import { describe, it, expect, beforeEach, vi } from 'vitest'

// ============================================================================
// ws mock — captures constructed sockets + sent frames; fires onopen async
// (mirrors the real handshake happening after the constructor returns) and
// answers each phx_join with a phx_reply, as Supabase does.
// ============================================================================

type SentFrame = { topic: string; event: string; payload: Record<string, unknown>; ref: string }

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
  const socketBehavior = {
    failConnections: 0,
    joinReply: { status: 'ok', response: {} } as Record<string, unknown> | null,
  }

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
      if (socketBehavior.failConnections > 0) {
        socketBehavior.failConnections--
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
      const frame = JSON.parse(data) as SentFrame
      this.sent.push(frame)
      const reply = socketBehavior.joinReply
      if (frame.event === 'phx_join' && reply) {
        queueMicrotask(() =>
          this.onmessage?.({
            data: JSON.stringify({ topic: frame.topic, event: 'phx_reply', payload: reply, ref: frame.ref }),
          }),
        )
      }
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
  socketBehavior.failConnections = 0
  socketBehavior.joinReply = { status: 'ok', response: {} }
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

describe('SupabaseRealtimeClient onConnect', () => {
  it('runs on the first open and again when the client reconnects by itself', async () => {
    vi.useFakeTimers()
    try {
      const onConnect = vi.fn()
      const client = new SupabaseRealtimeClient()
      await client.connect(BASE_CONFIG, () => {}, undefined, onConnect)
      expect(onConnect).toHaveBeenCalledTimes(1)

      sockets[0].onclose?.()
      await vi.advanceTimersByTimeAsync(1000)

      expect(sockets).toHaveLength(2)
      expect(onConnect).toHaveBeenCalledTimes(2)
      client.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SupabaseRealtimeClient connection failure', () => {
  it('rejects connect() when the socket closes before it ever opens', async () => {
    // The close event cancels the 10s timeout, so without an explicit
    // rejection the promise would never settle and callers awaiting
    // connect() (e.g. a manager installing its JWT-refresh interval after
    // the await) would hang forever.
    socketBehavior.failConnections = 1
    const client = new SupabaseRealtimeClient()

    await expect(client.connect(BASE_CONFIG, () => {})).rejects.toThrow(
      'WebSocket closed before the channel was joined',
    )

    client.disconnect()
  })
})

describe('SupabaseRealtimeClient channel health', () => {
  it('is active only after Supabase accepts the join, not when the socket opens', async () => {
    socketBehavior.joinReply = null
    const client = new SupabaseRealtimeClient()
    const onConnect = vi.fn()
    let joined = false
    const connecting = client.connect(BASE_CONFIG, () => {}, undefined, onConnect).then(() => {
      joined = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(joinFrames(sockets[0])).toHaveLength(1)
    expect(client.isActive()).toBe(false)
    expect(joined).toBe(false)
    expect(onConnect).not.toHaveBeenCalled()

    const [join] = joinFrames(sockets[0])
    sockets[0].onmessage?.({
      data: JSON.stringify({ topic: join.topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: join.ref }),
    })
    await connecting

    expect(client.isActive()).toBe(true)
    expect(onConnect).toHaveBeenCalledTimes(1)
    client.disconnect()
  })

  it('ignores heartbeat replies when deciding whether the channel is joined', async () => {
    socketBehavior.joinReply = null
    const client = new SupabaseRealtimeClient()
    void client.connect(BASE_CONFIG, () => {}).catch(() => {})
    await Promise.resolve()
    await Promise.resolve()

    sockets[0].onmessage?.({
      data: JSON.stringify({ topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: '999' }),
    })

    expect(client.isActive()).toBe(false)
    client.disconnect()
  })

  it('rejects connect() and stops when Supabase refuses the join for auth', async () => {
    vi.useFakeTimers()
    try {
      socketBehavior.joinReply = { status: 'error', response: { reason: 'Unauthorized: You do not have permissions to read from this Channel topic' } }
      const client = new SupabaseRealtimeClient()

      await expect(client.connect(BASE_CONFIG, () => {})).rejects.toThrow(
        'Realtime channel join rejected: Unauthorized',
      )
      expect(client.isActive()).toBe(false)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(sockets).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps retrying when a rejoin is refused for a transient reason', async () => {
    vi.useFakeTimers()
    try {
      const client = new SupabaseRealtimeClient()
      await client.connect(BASE_CONFIG, () => {})

      socketBehavior.joinReply = { status: 'error', response: { reason: 'RealtimeRestarting: Realtime is restarting' } }
      sockets[0].onclose?.()
      await vi.advanceTimersByTimeAsync(1000)
      expect(sockets).toHaveLength(2)
      expect(client.isActive()).toBe(false)

      socketBehavior.joinReply = { status: 'ok', response: {} }
      await vi.advanceTimersByTimeAsync(60_000)

      expect(sockets).toHaveLength(3)
      expect(client.isActive()).toBe(true)
      client.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns active again when Supabase recovers the Postgres subscription', async () => {
    const client = new SupabaseRealtimeClient()
    const received: unknown[] = []
    await client.connect(BASE_CONFIG, (record) => received.push(record))
    const send = (msg: Record<string, unknown>) =>
      sockets[0].onmessage?.({ data: JSON.stringify({ topic: 'realtime:public:webhook_events', ...msg }) })

    send({ event: 'system', payload: { status: 'error', message: 'Unable to connect to the project database', extension: 'postgres_changes' } })
    expect(client.isActive()).toBe(false)

    send({ event: 'system', payload: { status: 'ok', message: 'Subscribed to PostgreSQL', extension: 'postgres_changes' } })
    send({ event: 'postgres_changes', payload: { data: { type: 'INSERT', record: { id: 'evt_1' } } } })

    expect(received).toEqual([{ id: 'evt_1' }])
    expect(client.isActive()).toBe(true)
    client.disconnect()
  })

  it('stays inactive when a subscription ok arrives after the channel closed', async () => {
    const client = new SupabaseRealtimeClient()
    await client.connect(BASE_CONFIG, () => {})
    const send = (msg: Record<string, unknown>) =>
      sockets[0].onmessage?.({ data: JSON.stringify({ topic: 'realtime:public:webhook_events', ...msg }) })

    send({ event: 'phx_close', payload: {} })
    send({ event: 'system', payload: { status: 'ok', message: 'Subscribed to PostgreSQL', extension: 'postgres_changes' } })

    expect(client.isActive()).toBe(false)
    client.disconnect()
  })

  it('turns inactive when Supabase reports the token expired after joining', async () => {
    const client = new SupabaseRealtimeClient()
    await client.connect(BASE_CONFIG, () => {})
    expect(client.isActive()).toBe(true)

    sockets[0].onmessage?.({
      data: JSON.stringify({
        topic: 'realtime:public:webhook_events',
        event: 'system',
        payload: { status: 'error', message: 'Token has expired 5 seconds ago', extension: 'system' },
      }),
    })

    expect(client.isActive()).toBe(false)
    client.disconnect()
  })

  it('turns inactive when the server closes the channel but keeps the socket', async () => {
    const client = new SupabaseRealtimeClient()
    await client.connect(BASE_CONFIG, () => {})

    sockets[0].onmessage?.({
      data: JSON.stringify({ topic: 'realtime:public:webhook_events', event: 'phx_close', payload: {} }),
    })

    expect(client.isActive()).toBe(false)
    client.disconnect()
  })

  it('keeps reconnecting past 10 failed attempts and rejoins', async () => {
    vi.useFakeTimers()
    try {
      const client = new SupabaseRealtimeClient()
      await client.connect(BASE_CONFIG, () => {})

      socketBehavior.failConnections = 12
      sockets[0].onclose?.()
      await vi.advanceTimersByTimeAsync(10 * 60_000)

      expect(sockets).toHaveLength(14)
      expect(client.isActive()).toBe(true)
      client.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})
