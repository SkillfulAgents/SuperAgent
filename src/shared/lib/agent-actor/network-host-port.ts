/**
 * The host port over HTTP, for an actor that runs away from its host.
 *
 * - `call` is one request: `POST <base>/host/call/<name>`, answered with the
 *   host's result or its error (rebuilt through the actor error codec).
 * - `send` returns at once, as the port promises. The event goes into an
 *   outbox first, and the outbox is posted in order (`POST <base>/host/events`)
 *   until the host acknowledges it; a failed post is retried with backoff.
 *   Delivery is at least once: the host drops an event id its ledger has
 *   already seen. The ledger is this process's memory unless the deployment
 *   supplies one every host process shares.
 *
 * The outbox is where unacknowledged events survive the actor: in memory by
 * default, or a durable store the deployment supplies.
 */
import { decodeActorError, encodeActorError, type ActorErrorData } from './actor-error-codec'
import type { HostCalls, HostEvents, HostPort } from './host-port'
import { decodeWire, encodeWire } from './actor-wire'
import type { ActorFetch } from './network-actor'
import { background } from '@shared/lib/background'
import { captureException } from '@shared/lib/error-reporting'

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
  /** A flush was asked for while one ran: that one may have read the outbox before the new event landed. */
  let flushAgain = false
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
    if (flushing) {
      flushAgain = true
      return flushing
    }
    flushing = (async () => {
      try {
        do {
          flushAgain = false
          await appended
          if (!(await postOnce())) {
            const delay = delays[Math.min(attempt++, delays.length - 1)]
            if (retry) clearTimeout(retry)
            retry = setTimeout(() => {
              retry = null
              background(flush, { name: 'agent-actor.retry-host-events' })
            }, delay)
            retry.unref?.()
            return
          }
          attempt = 0
        } while (flushAgain)
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
      appended = appended.then(() => outbox.append(entry)).catch((error: unknown) => {
        // This event is lost; the ones sent after it still go.
        console.error(`[HostPort] Could not store host event ${name}:`, error)
        captureException(error, { tags: { area: 'agent-actor', op: 'host-event-append' }, extra: { name } })
      })
      background(flush, { name: 'agent-actor.flush-host-events' })
    },
    flush,
  }
}

/** The host event ids already handled. A host served by many processes supplies one they all share. */
export interface HostEventLedger {
  /** True the first time `id` is seen. */
  claim(id: string): Promise<boolean> | boolean
}

/** The ids this process has seen, the newest `remember` of them. */
export function memoryLedger(remember = 10_000): HostEventLedger {
  const seen = new Set<string>()
  return {
    claim(id) {
      if (seen.has(id)) return false
      seen.add(id)
      if (seen.size > remember) seen.delete(seen.values().next().value as string)
      return true
    },
  }
}

/**
 * Answers `remoteHostPort` from the host's own port. An event id the ledger
 * has already seen (a retried post whose first try landed) is acknowledged and
 * not sent again.
 */
export function serveHostPort(port: HostPort, options: { ledger?: HostEventLedger } = {}): ActorFetch {
  const ledger = options.ledger ?? memoryLedger()
  return async (request) => {
    const url = new URL(request.url)
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    if (url.pathname === '/host/events') {
      const entries = (await request.json()) as HostEventEntry[]
      for (const entry of entries) {
        if (!(await ledger.claim(entry.id))) continue
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
