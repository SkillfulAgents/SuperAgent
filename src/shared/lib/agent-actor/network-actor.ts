/**
 * The actor over HTTP: `remoteActor` is an `AgentActor` whose every op is one
 * request, and `serveActor` answers those requests from the actor itself. The
 * two meet at a `fetch`-shaped function, so the actor can sit in another
 * process (a Durable Object, a worker) or in this one behind a loopback.
 *
 * An op is `POST <base>/agents/<slug>/op/<group>.<op>`. Its body and its
 * response are NDJSON: a head line (`{"v": args}` going in; `{"v": result}`
 * or `{"e": error}` coming back), then a frame per chunk of each stream the
 * head holds (`{"s": id, "c": chunk}`, `{"s": id, "end": 1}`, `{"s": id,
 * "err": error}`). Values use a tagged JSON form that keeps what structured
 * clone keeps (undefined, Date, Map, Set, bytes, bigint, errors). Errors go
 * through the actor error codec, so callers still branch on their class.
 *
 * `container.fetch` is a pipe, not a call: `<base>/agents/<slug>/pipe/
 * container.fetch?path=…` carries the caller's method, headers and body, and
 * the container's response comes back as it is.
 *
 * An `AbortSignal` crosses only into the pure reads that take an advisory one
 * (`messages.page`, `delta`, `media`): it aborts the request, and the actor
 * sees the request's own signal.
 */
import { decodeActorError, encodeActorError, type ActorErrorData } from './actor-error-codec'
import { ACTOR_GROUPS, type AgentActor, type AgentSlug } from './types'

/** Anything that turns a request into a response: `fetch`, a service binding, a handler in this process. */
export type ActorFetch = (request: Request) => Promise<Response>

const SIGNAL_OPS = new Set(['messages.page', 'messages.delta', 'messages.media'])
/** Groups inside groups; everything else on a group is an op. */
const NESTED_GROUPS: Record<string, readonly string[]> = {
  inputs: ['reviews', 'computerUse', 'mcpReauth', 'accountReauth'],
}
const OP_SEGMENT = /^[a-zA-Z][a-zA-Z0-9]*$/
const PIPE_PATH = 'container.fetch'
const ERROR_HEADER = 'x-actor-error'
/** The caller's RequestInit without its body and signal, as wire data. */
const INIT_HEADER = 'x-actor-init'
/** How the far side hands the body back: `text` (a string), `bytes`, or `stream`. */
const BODY_HEADER = 'x-actor-body'
/** The caller passed a signal: the far side hands on the request's own. */
const SIGNAL_HEADER = 'x-actor-signal'
const NDJSON = 'application/x-ndjson'

// ============================================================================
// Values
// ============================================================================

interface StreamSink {
  /** A stream in the value: it gets an id, and its chunks are framed after the head. */
  add(stream: ReadableStream<unknown>): number
}

interface StreamSource {
  /** The stream the frames with this id feed. */
  get(id: number): ReadableStream<unknown>
}

function encodeValue(value: unknown, where: string, sink: StreamSink, signalOk: boolean): unknown {
  if (value === undefined) return { $t: 'u' }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value
    return { $t: 'n', v: String(value) }
  }
  if (typeof value === 'bigint') return { $t: 'big', v: value.toString() }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`${where} cannot cross the actor's boundary: a ${typeof value} is not data`)
  }
  if (value instanceof ReadableStream) return { $t: 'stream', id: sink.add(value) }
  if (value instanceof AbortSignal) {
    if (signalOk) return { $t: 'signal' }
    throw new TypeError(`${where} cannot cross the actor's boundary: an AbortSignal is passed only to a pure read`)
  }
  if (value instanceof Date) return { $t: 'date', v: value.getTime() }
  if (value instanceof Uint8Array) return { $t: 'u8', v: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  if (value instanceof ArrayBuffer) return { $t: 'ab', v: Buffer.from(value).toString('base64') }
  if (value instanceof Error) return { $t: 'err', v: encodeActorError(value) }
  if (value instanceof Map) {
    return { $t: 'map', v: [...value].map(([k, v], i) => [encodeValue(k, `${where}[${i}]`, sink, signalOk), encodeValue(v, `${where}[${i}]`, sink, signalOk)]) }
  }
  if (value instanceof Set) return { $t: 'set', v: [...value].map((v, i) => encodeValue(v, `${where}[${i}]`, sink, signalOk)) }
  if (Array.isArray(value)) return value.map((item, i) => encodeValue(item, `${where}[${i}]`, sink, signalOk))
  // Any other object crosses as its own enumerable fields, as structured clone carries a class instance.
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = encodeValue(item, `${where}.${key}`, sink, signalOk)
  return '$t' in out ? { $t: 'obj', v: out } : out
}

function decodeValue(value: unknown, source: StreamSource, signal: AbortSignal | undefined): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => decodeValue(item, source, signal))
  const tagged = value as { $t?: string; v?: unknown; id?: number }
  switch (tagged.$t) {
    case undefined: {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) out[key] = decodeValue(item, source, signal)
      return out
    }
    case 'u': return undefined
    case 'n': return Number(tagged.v)
    case 'big': return BigInt(tagged.v as string)
    case 'stream': return source.get(tagged.id as number)
    case 'signal': return signal ?? new AbortController().signal
    case 'date': return new Date(tagged.v as number)
    case 'u8': return new Uint8Array(Buffer.from(tagged.v as string, 'base64'))
    case 'ab': {
      const bytes = Buffer.from(tagged.v as string, 'base64')
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    }
    case 'err': return decodeActorError(tagged.v as ActorErrorData)
    case 'map': return new Map((tagged.v as unknown[][]).map(([k, v]) => [decodeValue(k, source, signal), decodeValue(v, source, signal)]))
    case 'set': return new Set((tagged.v as unknown[]).map((v) => decodeValue(v, source, signal)))
    case 'obj': {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(tagged.v as object)) out[key] = decodeValue(item, source, signal)
      return out
    }
    default: throw new TypeError(`Unknown actor wire tag ${tagged.$t}`)
  }
}

const noWireStreams: StreamSource = { get: () => { throw new TypeError('This value carries no streams') } }

/** A value with no streams in it as JSON-safe wire data, keeping what structured clone keeps. */
export function encodeWire(value: unknown, where: string): unknown {
  return encodeValue(value, where, { add: () => { throw new TypeError(`${where} cannot cross: no streams here`) } }, false)
}

export function decodeWire(value: unknown): unknown {
  return decodeValue(value, noWireStreams, undefined)
}

// ============================================================================
// Bodies
// ============================================================================

type Frame = { v: unknown } | { e: ActorErrorData } | { s: number; c?: unknown; end?: 1; err?: ActorErrorData }

const encoder = new TextEncoder()
const line = (frame: Frame): Uint8Array => encoder.encode(`${JSON.stringify(frame)}\n`)

/**
 * The head, then every stream it holds, as one NDJSON body. Streams are read
 * one chunk at a time each, interleaved; cancelling the body cancels them.
 */
function writeBody(head: (sink: StreamSink) => Frame, where: string): ReadableStream<Uint8Array> {
  const streams: ReadableStream<unknown>[] = []
  const sink: StreamSink = { add: (stream) => streams.push(stream) - 1 }
  const first = head(sink)
  const readers = streams.map((stream) => stream.getReader())
  const open = new Set(readers.keys())
  let headSent = false
  let turn = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headSent) {
        headSent = true
        controller.enqueue(line(first))
        if (open.size === 0) controller.close()
        return
      }
      const ids = [...open]
      const id = ids[turn++ % ids.length]
      try {
        const { done, value } = await readers[id].read()
        if (done) {
          open.delete(id)
          controller.enqueue(line({ s: id, end: 1 }))
        } else {
          controller.enqueue(line({ s: id, c: encodeValue(value, `${where} stream chunk`, noStreams, false) }))
        }
      } catch (error) {
        open.delete(id)
        controller.enqueue(line({ s: id, err: encodeActorError(error) }))
      }
      if (open.size === 0) controller.close()
    },
    cancel(reason) {
      for (const id of open) void readers[id].cancel(reason).catch(() => {})
      open.clear()
    },
  })
}

const noStreams: StreamSink = {
  add: () => {
    throw new TypeError('A stream chunk cannot hold another stream')
  },
}

/**
 * Reads an NDJSON body: resolves with the head, and feeds the frames after it
 * to the streams the head named. Once every stream the caller holds has ended
 * or been cancelled, the body is let go.
 */
async function readBody(body: ReadableStream<Uint8Array>): Promise<{ head: Frame; source: StreamSource }> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ''
  const lines: string[] = []
  let ended = false
  const nextLine = async (): Promise<string | null> => {
    while (lines.length === 0) {
      if (ended) return null
      const { done, value } = await reader.read()
      if (done) {
        ended = true
        if (buffered) lines.push(buffered)
        buffered = ''
        break
      }
      buffered += value
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      lines.push(...parts.filter(Boolean))
    }
    return lines.shift() ?? null
  }

  const first = await nextLine()
  if (first === null) throw new TypeError('The actor sent an empty body')
  const head = JSON.parse(first) as Frame

  const controllers = new Map<number, ReadableStreamDefaultController<unknown>>()
  const live = new Set<number>()
  let pumping = false
  const release = () => {
    if (live.size === 0) void reader.cancel().catch(() => {})
  }
  const pump = async () => {
    if (pumping) return
    pumping = true
    try {
      for (let text = await nextLine(); text !== null; text = await nextLine()) {
        const frame = JSON.parse(text) as { s: number; c?: unknown; end?: 1; err?: ActorErrorData }
        const controller = controllers.get(frame.s)
        if (!controller || !live.has(frame.s)) continue
        if (frame.end) {
          live.delete(frame.s)
          controller.close()
        } else if (frame.err) {
          live.delete(frame.s)
          controller.error(decodeActorError(frame.err))
        } else {
          controller.enqueue(decodeValue(frame.c, { get: () => { throw new TypeError('nested stream') } }, undefined))
        }
        if (live.size === 0) break
      }
    } catch (error) {
      for (const id of live) controllers.get(id)?.error(error)
      live.clear()
    }
    for (const id of live) controllers.get(id)?.error(new TypeError('The actor closed the body before the stream ended'))
    live.clear()
    release()
  }

  const source: StreamSource = {
    get(id) {
      live.add(id)
      return new ReadableStream<unknown>({
        start: (controller) => {
          controllers.set(id, controller)
          void pump()
        },
        cancel: () => {
          live.delete(id)
          release()
        },
      })
    },
  }
  return { head, source }
}

// ============================================================================
// Client
// ============================================================================

function opUrl(base: string, slug: AgentSlug, path: string): string {
  return `${base}/agents/${encodeURIComponent(slug)}/op/${path}`
}

async function callOp(send: ActorFetch, base: string, slug: AgentSlug, path: string, args: unknown[]): Promise<unknown> {
  const signalOk = SIGNAL_OPS.has(path)
  const signals = signalOk ? args.flatMap(findSignals) : []
  const body = writeBody((sink) => ({ v: encodeValue(args, `${path} argument`, sink, signalOk) }), `${path} argument`)
  const request = new Request(opUrl(base, slug, path), {
    method: 'POST',
    headers: { 'content-type': NDJSON },
    body,
    signal: signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    // @ts-expect-error -- Node's fetch needs `duplex` for a streamed body; the DOM type does not list it.
    duplex: 'half',
  })
  const response = await send(request)
  if (!response.ok || !response.body) throw new Error(`Actor ${slug} ${path}: HTTP ${response.status} ${await response.text().catch(() => '')}`)
  const { head, source } = await readBody(response.body)
  if ('e' in head) throw decodeActorError(head.e)
  if (!('v' in head)) throw new TypeError(`Actor ${slug} ${path}: malformed response head`)
  return decodeValue(head.v, source, undefined)
}

function findSignals(value: unknown): AbortSignal[] {
  if (value instanceof AbortSignal) return [value]
  if (value && typeof value === 'object' && !(value instanceof ReadableStream) && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).flatMap(findSignals)
  }
  return []
}

async function pipeContainerFetch(send: ActorFetch, base: string, slug: AgentSlug, path: string, init?: RequestInit): Promise<Response> {
  const url = `${base}/agents/${encodeURIComponent(slug)}/pipe/${PIPE_PATH}?path=${encodeURIComponent(path)}`
  const { body, signal, ...rest } = init ?? {}
  const headers = rest.headers instanceof Headers ? Object.fromEntries(rest.headers) : rest.headers
  const kind = body == null ? null : typeof body === 'string' ? 'text' : body instanceof Uint8Array || body instanceof ArrayBuffer ? 'bytes' : 'stream'
  const request = new Request(url, {
    method: 'POST',
    headers: {
      ...(init ? { [INIT_HEADER]: encodeURIComponent(JSON.stringify(encodeValue({ ...rest, ...(headers ? { headers } : {}) }, `${PIPE_PATH} init`, noStreams, false))) } : {}),
      ...(kind ? { [BODY_HEADER]: kind } : {}),
      ...(signal ? { [SIGNAL_HEADER]: '1' } : {}),
    },
    ...(body != null ? { body: body as BodyInit } : {}),
    ...(signal ? { signal } : {}),
    // @ts-expect-error -- see callOp: `duplex` for a streamed body.
    duplex: 'half',
  })
  const response = await send(request)
  if (response.headers.get(ERROR_HEADER)) throw decodeActorError((await response.json()) as ActorErrorData)
  return response
}

/**
 * A group whose ops are requests. Over a `local` group (the loopback test
 * transport) writes land on that group, so a test that replaces or spies on
 * an op there is still heard: the op runs on the far side, where it is
 * looked up on each call.
 */
function remoteGroup(call: (path: string, args: unknown[]) => Promise<unknown>, path: string, local?: object): object {
  const nested = new Map((NESTED_GROUPS[path] ?? []).map((name) => [
    name,
    remoteGroup(call, `${path}.${name}`, local ? (Reflect.get(local, name) as object | undefined) : undefined),
  ]))
  const ops = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  return new Proxy((local ?? Object.create(null)) as object, {
    get(target, key) {
      // Not a thenable, and no symbol is an op.
      if (typeof key !== 'string' || key === 'then') return local ? Reflect.get(target, key) : undefined
      const group = nested.get(key)
      if (group) return group
      if (local && typeof Reflect.get(target, key) !== 'function') return Reflect.get(target, key)
      let op = ops.get(key)
      if (!op) {
        const opPath = `${path}.${key}`
        op = (...args: unknown[]) => call(opPath, args)
        ops.set(key, op)
      }
      return op
    },
    getPrototypeOf: () => Object.prototype,
  })
}

/** Every group of an actor reached through `send`, and its `live`. */
export function remoteActorOps(
  slug: AgentSlug,
  send: ActorFetch,
  base = 'http://actor',
  local?: AgentActor,
): Pick<AgentActor, 'live' | (typeof ACTOR_GROUPS)[number]> {
  const call = (path: string, args: unknown[]) => callOp(send, base, slug, path, args)
  const groups = Object.fromEntries(ACTOR_GROUPS.map((name) => [name, remoteGroup(call, name, local?.[name])])) as Record<string, object>
  const container = groups.container
  groups.container = new Proxy(container, {
    get(target, key, receiver) {
      if (key === 'fetch') return (path: string, init?: RequestInit) => pipeContainerFetch(send, base, slug, path, init)
      return Reflect.get(target, key, receiver)
    },
  })
  return { ...groups, live: () => call('live', []) } as unknown as Pick<AgentActor, 'live' | (typeof ACTOR_GROUPS)[number]>
}

/**
 * A test transport: the actor behind its own HTTP server in this process.
 * Every op goes out as a real `Request` and comes back as a real `Response`
 * through `serveActor`; anything else (`slug`, the local actor's state that a
 * test reaches by a cast) is the actor's own.
 */
export function loopbackActor(actor: AgentActor): AgentActor {
  const ops = remoteActorOps(actor.slug, serveActor(() => actor), undefined, actor) as Record<string, unknown>
  return new Proxy(actor, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key in ops) return ops[key]
      return Reflect.get(target, key, receiver)
    },
  })
}

/** An actor that runs wherever `send` reaches. */
export function remoteActor(slug: AgentSlug, send: ActorFetch, base?: string): AgentActor {
  return { slug, ...remoteActorOps(slug, send, base) }
}

// ============================================================================
// Server
// ============================================================================

/**
 * Answers `remoteActor`'s requests from the actor `resolve` hands back for a
 * slug. Paths outside `/agents/<slug>/op|pipe/…` get 404; an op path names
 * only a function on an actor group (no prototype keys, no `constructor`).
 */
export function serveActor(resolve: (slug: AgentSlug) => AgentActor | Promise<AgentActor>): ActorFetch {
  return async (request) => {
    const url = new URL(request.url)
    const match = /^\/agents\/([^/]+)\/(op|pipe)\/([^/]+)$/.exec(url.pathname)
    if (!match) return new Response('Not found', { status: 404 })
    const [, rawSlug, kind, path] = match
    const actor = await resolve(decodeURIComponent(rawSlug))

    if (kind === 'pipe') {
      if (path !== PIPE_PATH) return new Response('Not found', { status: 404 })
      try {
        const rawInit = request.headers.get(INIT_HEADER)
        const target = url.searchParams.get('path') ?? '/'
        if (rawInit === null) return await actor.container.fetch(target)
        const init = decodeValue(JSON.parse(decodeURIComponent(rawInit)), { get: () => { throw new TypeError('no streams') } }, undefined) as RequestInit
        const kind = request.headers.get(BODY_HEADER)
        const body = kind === 'text' ? await request.text()
          : kind === 'bytes' ? new Uint8Array(await request.arrayBuffer())
          : kind === 'stream' ? request.body
          : undefined
        return await actor.container.fetch(target, {
          ...init,
          ...(body !== undefined ? { body } : {}),
          ...(kind === 'stream' ? { duplex: 'half' } : {}),
          ...(request.headers.get(SIGNAL_HEADER) ? { signal: request.signal } : {}),
        } as RequestInit)
      } catch (error) {
        return Response.json(encodeActorError(error), { headers: { [ERROR_HEADER]: '1' } })
      }
    }

    const op = lookupOp(actor, path)
    if (!op) return new Response(`No op ${path}`, { status: 404 })
    if (!request.body) return new Response('Missing body', { status: 400 })
    const { head, source } = await readBody(request.body)
    if (!('v' in head) || !Array.isArray(head.v)) return new Response('Malformed head', { status: 400 })
    const args = decodeValue(head.v, source, request.signal) as unknown[]

    let frame: (sink: StreamSink) => Frame
    try {
      let pending: unknown
      try {
        pending = op.fn.apply(op.owner, args)
      } catch (error) {
        throw new TypeError(`${path} threw instead of rejecting`, { cause: error })
      }
      const result = await pending
      frame = (sink) => ({ v: encodeValue(result, `${path} result`, sink, false) })
    } catch (error) {
      const data = encodeActorError(error)
      frame = () => ({ e: data })
    }
    try {
      return new Response(writeBody(frame, `${path} result`), { headers: { 'content-type': NDJSON } })
    } catch (error) {
      // A result that cannot cross fails the call, the way a thrown error does.
      const data = encodeActorError(error)
      return new Response(writeBody(() => ({ e: data }), path), { headers: { 'content-type': NDJSON } })
    }
  }
}

function lookupOp(actor: AgentActor, path: string): { owner: object; fn: (...args: unknown[]) => unknown } | null {
  const segments = path.split('.')
  if (segments.some((segment) => !OP_SEGMENT.test(segment) || segment === 'constructor')) return null
  if (path === 'live') return { owner: actor, fn: actor.live as (...args: unknown[]) => unknown }
  const [group, ...rest] = segments
  if (!(ACTOR_GROUPS as readonly string[]).includes(group) || rest.length === 0 || rest.length > 2) return null
  if (rest.length === 2 && !(NESTED_GROUPS[group] ?? []).includes(rest[0])) return null
  let owner: unknown = actor[group as (typeof ACTOR_GROUPS)[number]]
  for (const segment of rest.slice(0, -1)) owner = (owner as Record<string, unknown> | undefined)?.[segment]
  const fn = (owner as Record<string, unknown> | undefined)?.[rest[rest.length - 1]]
  return typeof fn === 'function' && owner ? { owner: owner as object, fn: fn as (...args: unknown[]) => unknown } : null
}
