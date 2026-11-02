/**
 * The host port over HTTP, for an actor that runs away from its host.
 *
 * - `call` is one request: `POST <base>/host/call/<name>`, answered with the
 *   host's result or its error (rebuilt through the actor error codec).
 * - `send` returns at once, as the port promises. The event goes into an
 *   outbox first, and the outbox is posted in order (`POST <base>/host/events`)
 *   until the host acknowledges it; a failed post is retried with backoff.
 *   Delivery is at least once: the host drops an event id it has already seen.
 *
 * The outbox is where unacknowledged events survive the actor: in memory by
 * default, or a store the deployment supplies (Durable Object storage).
 */
import { decodeActorError, encodeActorError, type ActorErrorData } from './actor-error-codec'
import type { HostCalls, HostEvents, HostPort } from './host-port'
import { decodeWire, encodeWire, type ActorFetch } from './network-actor'

export interface HostEventEntry {
  id: string
  name: keyof HostEvents
  event: unknown
}

/** Where sent events wait until the host acknowledges them, oldest first. */
export interface HostEventOutbox {
  append(entry: HostEventEntry): Promise<void> | void
  pending(): Promise<HostEventEntry[]> | HostEventEntry[]
  acknowledge(ids: readonly string[]): Promise<void> | void
}

export function memoryOutbox(): HostEventOutbox {
  let entries: HostEventEntry[] = []
  return {
    append: (entry) => {
      entries.push(entry)
    },
    pending: () => [...entries],
    acknowledge: (ids) => {
      const done = new Set(ids)
      entries = entries.filter((entry) => !done.has(entry.id))
    },
  }
}

export interface RemoteHostPortOptions {
  base?: string
  outbox?: HostEventOutbox
  /** Waits between failed posts; the last one repeats. */
  retryDelaysMs?: readonly number[]
  /** At most this many events per post. */
  batchSize?: number
  newId?: () => string
}

export interface RemoteHostPort extends HostPort {
  /** Post whatever waits in the outbox now: after a restart, or before the actor sleeps. Resolves once it is empty or a post failed. */
  flush(): Promise<void>
}

export function remoteHostPort(send: ActorFetch, options: RemoteHostPortOptions = {}): RemoteHostPort {
  const base = options.base ?? 'http://host'
  const outbox = options.outbox ?? memoryOutbox()
  const delays = options.retryDelaysMs ?? [1_000, 5_000, 30_000]
  const batchSize = options.batchSize ?? 100
  const newId = options.newId ?? (() => crypto.randomUUID())
  let flushing: Promise<void> | null = null
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  // Appends land in send order even when the outbox is async.
  let appended: Promise<void> = Promise.resolve()

  const postOnce = async (): Promise<boolean> => {
    for (;;) {
      const entries = (await outbox.pending()).slice(0, batchSize)
      if (entries.length === 0) return true
      const response = await send(new Request(`${base}/host/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entries.map((entry) => ({ ...entry, event: encodeWire(entry.event, `host event ${entry.name}`) }))),
      })).catch(() => null)
      if (!response?.ok) return false
      await outbox.acknowledge(entries.map((entry) => entry.id))
    }
  }

  const flush = (): Promise<void> => {
    flushing ??= (async () => {
      try {
        await appended
        if (await postOnce()) {
          attempt = 0
          return
        }
        const delay = delays[Math.min(attempt++, delays.length - 1)]
        if (retry) clearTimeout(retry)
        retry = setTimeout(() => {
          retry = null
          void flush()
        }, delay)
        retry.unref?.()
      } finally {
        flushing = null
      }
    })()
    return flushing
  }

  return {
    async call<N extends keyof HostCalls>(name: N, request: HostCalls[N]['request']): Promise<HostCalls[N]['response']> {
      const response = await send(new Request(`${base}/host/call/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(encodeWire(request, `host call ${name}`)),
      }))
      const body = (await response.json()) as { v: unknown } | { e: ActorErrorData }
      if ('e' in body) throw decodeActorError(body.e)
      return decodeWire(body.v) as HostCalls[N]['response']
    },
    send(name, event) {
      const entry: HostEventEntry = { id: newId(), name, event }
      // Fails here, in the caller, as the local port's handler never would: an event that is not data can never be posted.
      encodeWire(event, `host event ${name}`)
      appended = appended.then(() => outbox.append(entry))
      void flush()
    },
    flush,
  }
}

/**
 * Answers `remoteHostPort` from the host's own port. An event id already seen
 * (a retried post whose first try landed) is acknowledged and not sent again.
 */
export function serveHostPort(port: HostPort, options: { rememberIds?: number } = {}): ActorFetch {
  const remember = options.rememberIds ?? 10_000
  const seen = new Set<string>()
  return async (request) => {
    const url = new URL(request.url)
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    if (url.pathname === '/host/events') {
      const entries = (await request.json()) as HostEventEntry[]
      for (const entry of entries) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        if (seen.size > remember) seen.delete(seen.values().next().value as string)
        port.send(entry.name, decodeWire(entry.event) as never)
      }
      return Response.json({ acknowledged: entries.length })
    }
    const call = /^\/host\/call\/([a-zA-Z]+)$/.exec(url.pathname)
    if (!call) return new Response('Not found', { status: 404 })
    const name = call[1] as keyof HostCalls
    try {
      const result = await port.call(name, decodeWire(await request.json()) as never)
      return Response.json({ v: encodeWire(result, `host call ${name} result`) })
    } catch (error) {
      return Response.json({ e: encodeActorError(error) })
    }
  }
}
