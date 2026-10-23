import { describe, expect, it } from 'vitest'
import { defaultSerovalPlugins } from '@tanstack/router-core'
import { fromCrossJSON, fromJSON, toCrossJSONStream, toJSON, toJSONAsync } from 'seroval'

const options = { plugins: defaultSerovalPlugins }

describe('router serialization after the Seroval security update', () => {
  it('preserves loader data, dates, special numbers, bigint, and escaped strings', () => {
    const value = {
      route: '/agents/example/sessions/one',
      query: '</script><script>example</script>\u2028',
      updated: new Date('2026-01-02T03:04:05Z'),
      count: 9007199254740993n,
      missing: undefined,
      values: [NaN, Infinity, -Infinity, -0],
      pattern: /agent\/[a-z]+/gi,
    }
    expect(fromJSON(toJSON(value, options), options)).toEqual(value)
  })

  it('preserves cyclic references shared between objects, Maps, and Sets', () => {
    const agent: { name: string; self?: unknown } = { name: 'example' }
    agent.self = agent
    const value = { agent, map: new Map([[agent, agent]]), set: new Set([agent]) }
    const copy = fromJSON<typeof value>(toJSON(value, options), options)
    expect(copy.agent.self).toBe(copy.agent)
    expect(copy.map.get(copy.agent)).toBe(copy.agent)
    expect([...copy.set][0]).toBe(copy.agent)
  })

  it('preserves shared binary buffers and view offsets', () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer
    const value = { buffer, bytes: new Uint8Array(buffer, 2, 3), view: new DataView(buffer, 1, 4) }
    const copy = fromJSON<typeof value>(toJSON(value, options), options)
    expect([...copy.bytes]).toEqual([3, 4, 5])
    expect(copy.bytes.buffer).toBe(copy.buffer)
    expect(copy.bytes.byteOffset).toBe(2)
    expect(copy.view.buffer).toBe(copy.buffer)
    expect(copy.view.getUint8(0)).toBe(2)
  })

  it('preserves typed arrays used by binary route data', () => {
    const value = [new Int16Array([-123, 456]), new Float64Array([Math.PI, -0]), new BigUint64Array([42n])]
    expect(fromJSON(toJSON(value, options), options)).toEqual(value)
  })

  it('preserves fulfilled deferred route data', async () => {
    const value = { deferred: Promise.resolve({ name: 'loaded', tags: new Set(['one']) }) }
    const copy = fromJSON<typeof value>(await toJSONAsync(value, options), options)
    await expect(copy.deferred).resolves.toEqual({ name: 'loaded', tags: new Set(['one']) })
  })

  it('roundtrips errors with the actual TanStack shallow-error plugin', () => {
    const copy = fromJSON<Error>(toJSON(new Error('loader failed'), options), options)
    expect(copy).toBeInstanceOf(Error)
    expect(copy.message).toBe('loader failed')
  })

  it('roundtrips binary stream frames with the actual router plugin', async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3]))
        controller.close()
      },
    })
    const refs = new Map<number, unknown>()
    let copy!: ReadableStream<Uint8Array>
    await new Promise<void>((resolve, reject) => {
      toCrossJSONStream(input, {
        ...options,
        onParse(node, initial) {
          const value = fromCrossJSON<ReadableStream<Uint8Array>>(node, { ...options, refs })
          if (initial) copy = value
        },
        onDone: resolve,
        onError: reject,
      })
    })
    const reader = copy.getReader()
    expect(await reader.read()).toEqual({ value: new Uint8Array([1, 2]), done: false })
    expect(await reader.read()).toEqual({ value: new Uint8Array([3]), done: false })
    expect(await reader.read()).toEqual({ value: undefined, done: true })
  })

  it('keeps prototype-like route keys as data', () => {
    const source = Object.fromEntries([['__proto__', { injected: true }], ['constructor', 'route']])
    const copy = fromJSON<Record<string, unknown>>(toJSON(source, options), options)
    expect(Object.hasOwn(copy, '__proto__')).toBe(true)
    expect(copy.__proto__).toEqual({ injected: true })
    expect(copy.constructor).toBe('route')
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
  })
})
