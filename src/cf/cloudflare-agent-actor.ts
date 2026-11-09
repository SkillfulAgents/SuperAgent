/**
 * Each agent's actor runs in its own AgentDurableObject. Everywhere else, `cloudflareAgentActor`
 * reaches it over Durable Object RPC: each op is one `actorCall` on the agent's object, which runs
 * it on the actor there (`runActorOp`). Values cross as RPC clones them (dates, maps, bytes,
 * streams, requests and responses); errors cross through the actor error codec, so callers still
 * branch on their class.
 */
import { decodeActorError, encodeActorError, type ActorErrorData } from '@shared/lib/agent-actor/actor-error-codec'
import { ACTOR_GROUPS, type AgentActor, type AgentSlug } from '@shared/lib/agent-actor/types'

export type ActorOutcome = { value: unknown } | { error: ActorErrorData }

/** The agent object's RPC method this module calls. */
export interface ActorObject {
  actorCall(path: string, args: unknown[]): Promise<ActorOutcome>
}

/** Groups inside groups; everything else on a group is an op. */
const NESTED_GROUPS: Record<string, readonly string[]> = {
  inputs: ['reviews', 'computerUse', 'mcpReauth', 'accountReauth'],
}
const OP_SEGMENT = /^[a-zA-Z][a-zA-Z0-9]*$/
const CONTAINER_FETCH = 'container.fetch'

// An AbortSignal does not cross RPC. The reads that take one use it only as advice.
function withoutSignal(arg: unknown): unknown {
  if (arg instanceof AbortSignal) return undefined
  if (!arg || typeof arg !== 'object' || Object.getPrototypeOf(arg) !== Object.prototype) return arg
  return Object.fromEntries(Object.entries(arg).filter(([, value]) => !(value instanceof AbortSignal)))
}

/** The agent's actor, in its object: `reach` runs a call on that object. */
export function cloudflareAgentActor(slug: AgentSlug, reach: (run: (agent: ActorObject) => Promise<ActorOutcome>) => Promise<ActorOutcome>): AgentActor {
  const call = async (path: string, args: unknown[]): Promise<unknown> => {
    const outcome = await reach((agent) => agent.actorCall(path, args))
    if ('error' in outcome) throw decodeActorError(outcome.error)
    return outcome.value
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
  return { slug, ...groups, live: () => call('live', []) } as unknown as AgentActor
}

/** Runs one op from `cloudflareAgentActor` on the actor in this object. */
export async function runActorOp(actor: AgentActor, path: string, args: unknown[]): Promise<ActorOutcome> {
  try {
    if (path === CONTAINER_FETCH) {
      const [target, request] = args as [string, Request | undefined]
      return { value: await actor.container.fetch(target, request && initOf(request)) }
    }
    const op = lookupOp(actor, path)
    if (!op) throw new TypeError(`No actor op ${path}`)
    return { value: await op.fn.apply(op.owner, args) }
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
  if (path === 'live') return { owner: actor, fn: actor.live as (...args: unknown[]) => unknown }
  const [group, ...rest] = segments
  if (!(ACTOR_GROUPS as readonly string[]).includes(group) || rest.length === 0 || rest.length > 2) return null
  if (rest.length === 2 && !(NESTED_GROUPS[group] ?? []).includes(rest[0])) return null
  let owner: unknown = actor[group as (typeof ACTOR_GROUPS)[number]]
  for (const segment of rest.slice(0, -1)) owner = (owner as Record<string, unknown> | undefined)?.[segment]
  const fn = (owner as Record<string, unknown> | undefined)?.[rest[rest.length - 1]]
  return typeof fn === 'function' && owner ? { owner: owner as object, fn: fn as (...args: unknown[]) => unknown } : null
}
