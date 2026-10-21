/**
 * A test transport: the actor as a caller would reach it over a wire. Every
 * op's arguments and result are structured-cloned (a function or a handle
 * fails to cross), so are the chunks of the streams it hands out or takes in,
 * the call yields a macrotask before it reaches the actor and after it
 * leaves, and a thrown error comes back through the error codec. A caller
 * that holds a reference into the actor's state, reads a result it did not
 * await, or counts on two calls running back to back finds out here. So does
 * a caller that takes a shortcut for a local actor (`files instanceof
 * LocalFileOps`): what it holds is no instance of the actor's classes.
 *
 * What a real transport carries by other means passes through as it is:
 * `container.fetch`'s request and response (the container transport), and the
 * advisory `AbortSignal` of the pure reads `messages.page`, `delta` and `media`.
 *
 * The registry hands actors out through it when SUPERAGENT_ACTOR_TRANSPORT is
 * `serializing` (see `registry.ts`).
 */
import { decodeActorError, encodeActorError } from './actor-error-codec'
import { ACTOR_GROUPS, type AgentActor } from './types'

/** The ops whose `AbortSignal` (an advisory one, on a pure read) passes as it is. */
const SIGNAL_OPS = new Set(['messages.page', 'messages.delta', 'messages.media'])

export function serializingActor(actor: AgentActor): AgentActor {
  const groups = new Map<PropertyKey, unknown>(ACTOR_GROUPS.map((name) => [name, wrapGroup(actor[name], name)]))
  const live = wrapOp(actor, 'live', 'live')
  return new Proxy(actor, {
    get(target, key, receiver) {
      if (groups.has(key)) return groups.get(key)
      if (key === 'live') return live
      // `slug`, and the local actor's own state for a test that reaches into it by a cast.
      return Reflect.get(target, key, receiver)
    },
  })
}

/**
 * The group as the caller reaches it: its methods (own or, for a class such
 * as the file operations, inherited) as ops over the wire, its nested groups
 * (`inputs.reviews`, …) the same way. Writes go to the group itself, so a test
 * that replaces a method replaces it on the actor.
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
      if (value && typeof value === 'object') {
        if (!reached.has(key)) reached.set(key, wrapGroup(value, `${path}.${key}`))
        return reached.get(key)
      }
      return value
    },
    getPrototypeOf: () => Object.prototype,
  })
}

// The op is looked up on each call, so a test that replaces it on the actor is still heard.
function wrapOp(owner: object, key: string, path: string): (...args: unknown[]) => Promise<unknown> {
  // The container transport is the one op that is a pipe, not a call.
  const pipe = path === 'container.fetch'
  const signal = SIGNAL_OPS.has(path)
  return async (...args: unknown[]) => {
    const sent = pipe ? args : args.map((arg) => cross(arg, `${path} argument`, signal))
    await macrotask()
    let result: unknown
    try {
      const op = Reflect.get(owner, key) as (...args: unknown[]) => unknown
      let pending: unknown
      try {
        pending = op.apply(owner, sent)
      } catch (error) {
        // Across a wire every failure is a rejection: an op that throws before
        // it returns its promise fails a caller that only handles rejections.
        throw new TypeError(`${path} threw instead of rejecting`, { cause: error })
      }
      result = await pending
    } catch (error) {
      const data = structuredClone(encodeActorError(error))
      await macrotask()
      throw decodeActorError(data)
    }
    await macrotask()
    return pipe ? result : cross(result, `${path} result`, false)
  }
}

/** A value as it arrives on the other side; what cannot cross throws. */
function cross(value: unknown, where: string, signal: boolean): unknown {
  if (value instanceof ReadableStream) return value.pipeThrough(cloningChunks(where))
  if (value instanceof AbortSignal) {
    if (signal) return value
    // structuredClone would make it an empty object, not refuse it.
    throw new TypeError(`${where} cannot cross the actor's boundary: an AbortSignal is passed only to a pure read`)
  }
  if (Array.isArray(value)) return value.map((item) => cross(item, where, signal))
  if (value && typeof value === 'object' && isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cross(item, `${where}.${key}`, signal)]))
  }
  try {
    return structuredClone(value)
  } catch (error) {
    throw new TypeError(`${where} cannot cross the actor's boundary: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** A stream's chunks as they arrive on the other side: one that is not data fails the stream. */
function cloningChunks(where: string): TransformStream<unknown, unknown> {
  return new TransformStream({
    transform(chunk, controller) {
      try {
        controller.enqueue(structuredClone(chunk))
      } catch (error) {
        controller.error(new TypeError(`${where} stream chunk cannot cross the actor's boundary: ${error instanceof Error ? error.message : String(error)}`))
      }
    },
  })
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
