/**
 * A test transport: the actor as a caller would reach it over a wire. Every
 * op's arguments and result are structured-cloned (a function or a handle
 * fails to cross), the call yields a macrotask before it reaches the actor
 * and after it leaves, and a thrown error comes back through the error codec.
 * A caller that holds a reference into the actor's state, reads a result it
 * did not await, or counts on two calls running back to back finds out here.
 *
 * What a real transport carries by other means passes through as it is: byte
 * and event streams (piped), `container.fetch`'s request and response (the
 * container transport), and the advisory `AbortSignal` of the pure reads.
 *
 * The registry hands actors out through it when SUPERAGENT_ACTOR_TRANSPORT is
 * `serializing` (see `registry.ts`).
 */
import { decodeActorError, encodeActorError } from './actor-error-codec'
import type { AgentActor } from './types'

/** The op groups of an actor, nested ones included; everything else on the handle is reached as it is. */
const GROUPS = ['container', 'sessions', 'messages', 'inputs', 'usage', 'files', 'memories', 'config'] as const
const NESTED = ['reviews', 'computerUse', 'mcpReauth', 'accountReauth'] as const

export function serializingActor(actor: AgentActor): AgentActor {
  const groups = new Map<PropertyKey, unknown>(GROUPS.map((name) => [name, wrapGroup(actor[name], name)]))
  const live = wrapOp(actor, 'live', 'live')
  return new Proxy(actor, {
    get(target, key, receiver) {
      if (groups.has(key)) return groups.get(key)
      if (key === 'live') return live
      return Reflect.get(target, key, receiver)
    },
  })
}

/**
 * The group as the caller reaches it: its methods (own or, for a class such
 * as the file operations, inherited) as ops over the wire, its nested groups
 * the same way. Writes go to the group itself, so a test that replaces a
 * method replaces it on the actor.
 */
function wrapGroup(group: object | undefined, path: string): object | undefined {
  // A test double may leave a group out.
  if (!group) return group
  const reached = new Map<PropertyKey, unknown>()
  return new Proxy(group, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof key !== 'string') return value
      if (typeof value === 'function') {
        if (!reached.has(key)) reached.set(key, wrapOp(target, key, `${path}.${key}`))
        return reached.get(key)
      }
      if ((NESTED as readonly string[]).includes(key) && value && typeof value === 'object') {
        if (!reached.has(key)) reached.set(key, wrapGroup(value, `${path}.${key}`))
        return reached.get(key)
      }
      return value
    },
  })
}

// The op is looked up on each call, so a test that replaces it on the actor is still heard.
function wrapOp(owner: object, key: string, path: string): (...args: unknown[]) => Promise<unknown> {
  // The container transport is the one op that is a pipe, not a call.
  const pipe = path === 'container.fetch'
  return async (...args: unknown[]) => {
    const sent = pipe ? args : args.map((arg) => cross(arg, `${path} argument`))
    await macrotask()
    let result: unknown
    try {
      const op = Reflect.get(owner, key) as (...args: unknown[]) => unknown
      result = await op.apply(owner, sent)
    } catch (error) {
      const data = structuredClone(encodeActorError(error))
      await macrotask()
      throw decodeActorError(data)
    }
    await macrotask()
    return pipe ? result : cross(result, `${path} result`)
  }
}

/** A value as it arrives on the other side; what cannot cross throws. */
function cross(value: unknown, where: string): unknown {
  if (passesThrough(value)) return value
  if (Array.isArray(value)) return value.map((item) => cross(item, where))
  if (value && typeof value === 'object' && isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cross(item, `${where}.${key}`)]))
  }
  try {
    return structuredClone(value)
  } catch (error) {
    throw new TypeError(`${where} cannot cross the actor's boundary: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function passesThrough(value: unknown): boolean {
  return value instanceof ReadableStream || value instanceof AbortSignal || value instanceof Response || value instanceof Request
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * One turn of the event loop, by a message port rather than a timer: a test
 * that fakes timers must not stall the transport.
 */
function macrotask(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      port2.close()
      resolve()
    }
    port2.postMessage(null)
  })
}
