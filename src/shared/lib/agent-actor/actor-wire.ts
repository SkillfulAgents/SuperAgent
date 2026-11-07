/**
 * The remote agent actor's wire format, shared by `remoteAgentActor` and `serveAgentActor`.
 *
 * A body is NDJSON: a head line (`{"v": args}` going in; `{"v": result}` or
 * `{"e": error}` coming back), then a frame per chunk of each stream the head
 * holds (`{"s": id, "c": chunk}`, `{"s": id, "end": 1}`, `{"s": id, "err":
 * error}`). Values use a tagged JSON form that keeps what structured clone
 * keeps (undefined, Date, Map, Set, bytes, bigint, errors). Errors go through
 * the actor error codec, so callers still branch on their class.
 */
import { decodeActorError, encodeActorError, type ActorErrorData } from './actor-error-codec'
import { background } from '@shared/lib/background'

// ============================================================================
// Values
// ============================================================================

export interface StreamSink {
  /** A stream in the value: it gets an id, and its chunks are framed after the head. */
  add(stream: ReadableStream<unknown>): number
}

interface StreamSource {
  /** The stream the frames with this id feed. */
  get(id: number): ReadableStream<unknown>
}

const tagOf = (value: unknown): string => Object.prototype.toString.call(value)

export function encodeValue(value: unknown, where: string, sink: StreamSink, signalOk: boolean): unknown {
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
  // By tag, not instanceof: bytes made in another realm (a Node Buffer under a jsdom test) are still bytes.
  if (tagOf(value) === '[object Uint8Array]') {
    const bytes = value as Uint8Array
    return { $t: 'u8', v: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') }
  }
  if (tagOf(value) === '[object ArrayBuffer]') return { $t: 'ab', v: Buffer.from(value as ArrayBuffer).toString('base64') }
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

export function decodeValue(value: unknown, source: StreamSource, signal: AbortSignal | undefined): unknown {
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

export type Frame = { v: unknown } | { e: ActorErrorData } | { s: number; c?: unknown; end?: 1; err?: ActorErrorData }

const encoder = new TextEncoder()
const line = (frame: Frame): Uint8Array => encoder.encode(`${JSON.stringify(frame)}\n`)

/**
 * The head, then every stream it holds, as one NDJSON body. Streams are read
 * one chunk at a time each, interleaved; cancelling the body cancels them.
 */
export function writeBody(head: (sink: StreamSink) => Frame, where: string): ReadableStream<Uint8Array> {
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
      for (const id of open) background(readers[id].cancel(reason).catch(() => {}), { name: 'agent-actor.cancel-stream' })
      open.clear()
    },
  })
}

export const noStreams: StreamSink = {
  add: () => {
    throw new TypeError('A stream chunk cannot hold another stream')
  },
}

/**
 * Reads an NDJSON body: resolves with the head, and feeds the frames after it
 * to the streams the head named. Once every stream the caller holds has ended
 * or been cancelled, the body is let go.
 */
export async function readBody(body: ReadableStream<Uint8Array>): Promise<{ head: Frame; source: StreamSource }> {
  // The DOM types give TextDecoderStream a BufferSource input, which a Uint8Array stream's pair type does not accept.
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader()
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
    if (live.size === 0) background(reader.cancel().catch(() => {}), { name: 'agent-actor.release-body' })
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
          background(pump, { name: 'agent-actor.pump-streams' })
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
