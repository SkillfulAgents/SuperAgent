/**
 * Each agent's actor runs in its own AgentDurableObject. Everywhere else, `cloudflareAgentActor`
 * reaches it over Durable Object RPC: each op is one `actorCall` on the agent's object, which runs
 * it on the actor there (`runActorOp`). Values cross as RPC clones them (dates, maps, bytes, byte
 * streams, requests and responses); errors cross through the actor error codec, so callers still
 * branch on their class. RPC carries only byte streams, so the ops that return a stream of objects
 * send it as JSON lines.
 *
 * No async context crosses RPC. In one process the actor's op runs inside the API request that
 * made it: the request's user is who the op acts for, and the request's settings read is shared.
 * Here the caller's user travels with the call, and the object runs the op as one operation of
 * that user (`runActorOp`).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentDurableObject } from './cloudflare-agent'
import type { Checked, Restarting } from '../lib/object-version'
import { decodeActorError, encodeActorError, type ActorErrorData } from '@shared/lib/agent-actor/actor-error-codec'
import { ACTOR_GROUPS, type AgentActor, type AgentSlug } from '@shared/lib/agent-actor/types'
import { runWithSettingsMemo } from '@shared/lib/config/settings-request-memo'
import { getRequestUserId, runWithOptionalUser } from '@shared/lib/platform-attribution/request-context'

export type ActorOutcome = { value: unknown } | { error: ActorErrorData }

/** The agent object's RPC method this module calls. */
export interface ActorObject {
  /**
   * With the caller's version, the object checks its own code first (object-version.ts).
   * `actingUserId`: the user the caller's request or run acts for, when it has one.
   */
  actorCall(path: string, args: unknown[], callerVersion?: string, actingUserId?: string): Promise<ActorOutcome | Restarting | Checked<ActorOutcome>>
}

/** Runs one call on the agent's object and resolves to its outcome; it hands `run` the version to send, if the object is not checked yet. */
export type ReachActorObject = (run: (agent: ActorObject, callerVersion?: string) => Promise<ActorOutcome | Restarting | Checked<ActorOutcome>>) => Promise<ActorOutcome>

/** Groups inside groups; everything else on a group is an op. */
const NESTED_GROUPS: Record<string, readonly string[]> = {
  inputs: ['reviews', 'computerUse', 'mcpReauth', 'accountReauth'],
}
const OP_SEGMENT = /^[a-zA-Z][a-zA-Z0-9]*$/
/** The actor's own calls, outside any group. */
type ActorCall = { [K in keyof AgentActor]: AgentActor[K] extends (...args: never[]) => unknown ? K : never }[keyof AgentActor]
// Every one of them: a call added to AgentActor and not named here fails the type check.
const ACTOR_CALLS: Record<ActorCall, true> = { live: true, listing: true }
const isActorCall = (path: string): path is ActorCall => Object.hasOwn(ACTOR_CALLS, path)
const CONTAINER_FETCH = 'container.fetch'
// The ops whose result is a stream of objects (a viewer's frames, the app's session events).
const OBJECT_STREAM_OPS = new Set(['messages.follow', 'messages.subscribe'])

/** A stream of JSON values as a byte stream of JSON lines, which RPC can carry. */
function toJsonLines(values: ReadableStream<unknown>): ReadableStream<Uint8Array> {
  const reader = values.getReader()
  const encoder = new TextEncoder()
  return new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
    },
    cancel: (reason) => reader.cancel(reason),
  })
}

/** The values of a JSON-lines byte stream. */
function fromJsonLines(bytes: ReadableStream<Uint8Array>): ReadableStream<unknown> {
  let buffered = ''
  return bytes.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).pipeThrough(new TransformStream<string, unknown>({
    transform(text, controller) {
      const lines = (buffered + text).split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) if (line) controller.enqueue(JSON.parse(line))
    },
    flush(controller) {
      if (buffered) controller.enqueue(JSON.parse(buffered))
    },
  }))
}

// An AbortSignal does not cross RPC. The reads that take one use it only as advice.
function withoutSignal(arg: unknown): unknown {
  if (arg instanceof AbortSignal) return undefined
  if (!arg || typeof arg !== 'object' || Object.getPrototypeOf(arg) !== Object.prototype) return arg
  return Object.fromEntries(Object.entries(arg).filter(([, value]) => !(value instanceof AbortSignal)))
}

/** The agent's actor, in its object: `reach` runs a call on that object. */
export function cloudflareAgentActor(slug: AgentSlug, reach: ReachActorObject): AgentActor {
  const call = async (path: string, args: unknown[]): Promise<unknown> => {
    // Read here, in the caller's own context: `reach` may run the call later, and the object never sees this context.
    const actingUserId = getRequestUserId()
    const outcome = await reach((agent, callerVersion) => agent.actorCall(path, args, callerVersion, actingUserId))
    if ('error' in outcome) throw decodeActorError(outcome.error)
    return OBJECT_STREAM_OPS.has(path) ? fromJsonLines(outcome.value as ReadableStream<Uint8Array>) : outcome.value
  }
  const group = (path: string): object => {
    const nested = new Map((NESTED_GROUPS[path] ?? []).map((name) => [name, group(`${path}.${name}`)]))
    return new Proxy(Object.create(null) as object, {
      // Not a thenable, and no symbol is an op.
      get: (_target, key) => (typeof key !== 'string' || key === 'then' ? undefined : nested.get(key) ?? ((...args: unknown[]) => call(`${path}.${key}`, args.map(withoutSignal)))),
    })
  }
  const groups = Object.fromEntries(ACTOR_GROUPS.map((name) => [name, group(name)])) as Record<string, object>
  const container = groups.container
  groups.container = new Proxy(container, {
    get: (target, key, receiver) => key === 'fetch'
      ? (path: string, init?: RequestInit) => call(CONTAINER_FETCH, [path, init && new Request('http://container', { ...init, signal: undefined })])
      : Reflect.get(target, key, receiver),
  })
  const calls = Object.fromEntries(Object.keys(ACTOR_CALLS).map((name) => [name, () => call(name, [])]))
  return { slug, ...groups, ...calls } as unknown as AgentActor
}

/**
 * Runs one op from `cloudflareAgentActor` on the actor in this object, as an API request runs:
 * the op's settings readers share one read, and what the op does for a user (platform calls,
 * access checks) is done for `actingUserId`. With no user, the op resolves one as a background
 * job does.
 */
export function runActorOp(actor: AgentActor, path: string, args: unknown[], actingUserId?: string): Promise<ActorOutcome> {
  return runWithSettingsMemo(async () => runWithOptionalUser(actingUserId, () => runOp(actor, path, args)))
}

async function runOp(actor: AgentActor, path: string, args: unknown[]): Promise<ActorOutcome> {
  try {
    if (path === CONTAINER_FETCH) {
      const [target, request] = args as [string, Request | undefined]
      return { value: await actor.container.fetch(target, request && initOf(request)) }
    }
    const op = lookupOp(actor, path)
    if (!op) throw new TypeError(`No actor op ${path}`)
    const value = await op.fn.apply(op.owner, args)
    return { value: OBJECT_STREAM_OPS.has(path) ? toJsonLines(value as ReadableStream<unknown>) : value }
  } catch (error) {
    return { error: encodeActorError(error) }
  }
}

function initOf(request: Request): RequestInit {
  return { method: request.method, headers: request.headers, ...(request.body ? { body: request.body, duplex: 'half' } : {}) } as RequestInit
}

// Only a function on an actor group: no prototype keys, no `constructor`.
function lookupOp(actor: AgentActor, path: string): { owner: object; fn: (...args: unknown[]) => unknown } | null {
  const segments = path.split('.')
  if (segments.some((segment) => !OP_SEGMENT.test(segment) || segment === 'constructor')) return null
  if (isActorCall(path)) return { owner: actor, fn: actor[path] as (...args: unknown[]) => unknown }
  const [group, ...rest] = segments
  if (!(ACTOR_GROUPS as readonly string[]).includes(group) || rest.length === 0 || rest.length > 2) return null
  if (rest.length === 2 && !(NESTED_GROUPS[group] ?? []).includes(rest[0])) return null
  let owner: unknown = actor[group as (typeof ACTOR_GROUPS)[number]]
  for (const segment of rest.slice(0, -1)) owner = (owner as Record<string, unknown> | undefined)?.[segment]
  const fn = (owner as Record<string, unknown> | undefined)?.[rest[rest.length - 1]]
  return typeof fn === 'function' && owner ? { owner: owner as object, fn: fn as (...args: unknown[]) => unknown } : null
}

/*
 * Which agent's object serves the current request in this isolate. Cloudflare can run several
 * Durable Objects of one class in one isolate, and SuperAgent's module state is shared by all of
 * them, while each object's storage may be touched only from that object's own requests. So an
 * agent's object is called directly only inside its own request, and through its stub otherwise.
 */
const serving = new AsyncLocalStorage<{ slug: AgentSlug; object: AgentDurableObject }>()

/** Runs `work` as the agent's own object: what it starts there (background work too) stays its own. */
export function runAsAgentObject<T>(slug: AgentSlug, object: AgentDurableObject, work: () => T): T {
  return serving.run({ slug, object }, work)
}

/** The agent's object when it is the one serving the current request; null otherwise. */
export function servingAgentObject(slug: AgentSlug): AgentDurableObject | null {
  const current = serving.getStore()
  return current?.slug === slug ? current.object : null
}

/**
 * The agent's actor, chosen at each use: inside the agent's own object it is the actor in this
 * isolate, and anywhere else the actor in that object, reached through `remote`. Chosen per use,
 * not once: an isolate can serve the agent's object and other callers.
 */
export function ownedHere(slug: AgentSlug, local: AgentActor, remote: AgentActor): AgentActor {
  return new Proxy(local, {
    get(_target, key) {
      return Reflect.get(servingAgentObject(slug) ? local : remote, key)
    },
  })
}
