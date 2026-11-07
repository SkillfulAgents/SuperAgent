/**
 * The remote agent actor: `remoteAgentActor` is an `AgentActor` whose every op is one
 * HTTP request, and `serveAgentActor` answers those requests from the actor itself. The
 * two meet at a `fetch`-shaped function, so the actor can sit in another
 * process or machine, or in this one behind a loopback.
 *
 * An op is `POST <base>/agents/<slug>/op/<group>.<op>`; its body and its
 * response use the actor wire format (`actor-wire.ts`).
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
import { type StreamSink, encodeValue, decodeValue, type Frame, writeBody, noStreams, readBody } from './actor-wire'

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
export function remoteAgentActorOps(
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
 * through `serveAgentActor`; anything else (`slug`, the local actor's state that a
 * test reaches by a cast) is the actor's own.
 */
export function loopbackActor(actor: AgentActor): AgentActor {
  const ops = remoteAgentActorOps(actor.slug, serveAgentActor(() => actor), undefined, actor) as Record<string, unknown>
  return new Proxy(actor, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key in ops) return ops[key]
      return Reflect.get(target, key, receiver)
    },
  })
}

/** Where `remoteAgentActor` sends an agent's ops: anything that answers requests, such as a Durable Object stub. */
export interface ActorTarget {
  /** The agent's slug, as a stub got by name carries it. */
  readonly name?: string
  fetch(request: Request): Promise<Response>
}

/** An actor that runs wherever `target` reaches. */
export function remoteAgentActor(target: ActorTarget, slug: AgentSlug | undefined = target.name, base?: string): AgentActor {
  if (!slug) throw new TypeError('remoteAgentActor needs the agent slug: a target got by name, or the slug itself')
  return { slug, ...remoteAgentActorOps(slug, (request) => target.fetch(request), base) }
}

// ============================================================================
// Server
// ============================================================================

/**
 * Answers `remoteAgentActor`'s requests from the actor `resolve` hands back for a
 * slug. Paths outside `/agents/<slug>/op|pipe/…` get 404; an op path names
 * only a function on an actor group (no prototype keys, no `constructor`).
 */
export function serveAgentActor(resolve: (slug: AgentSlug) => AgentActor | Promise<AgentActor>): ActorFetch {
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
