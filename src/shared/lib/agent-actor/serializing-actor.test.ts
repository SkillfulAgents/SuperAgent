/**
 * The serializing test transport, and the error codec it carries errors
 * with: what a caller sees of an actor reached over a wire.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeActorError, encodeActorError } from './actor-error-codec'
import { DeliveryError, StartError, deliveryFailure } from './delivery-errors'
import { WorkspaceFileError } from './workspace-path'
import { MemoryError } from './memory-schema'
import { ConfigDocError } from './config-schema'
import { serializingActor } from './serializing-actor'
import { findAgentRuntimeError } from '@shared/lib/agent-runtime-errors/agent-runtime-error'
import { ProviderReconnectRequiredError } from '@shared/lib/agent-runtime-errors/provider-reconnect-required/provider-reconnect-required-error'
import type { AgentActor } from './types'

/** An actor whose ops are the given functions, in their groups. */
function actorOf(groups: Record<string, Record<string, unknown>>, live?: () => Promise<unknown>): AgentActor {
  return { slug: 'a', live: live ?? (async () => ({})), ...groups } as unknown as AgentActor
}

const crossed = (error: unknown) => decodeActorError(structuredClone(encodeActorError(error)))

describe('the error codec', () => {
  it('rebuilds the errors callers branch on as their own class, fields and message kept', () => {
    const file = crossed(new WorkspaceFileError('not-found', 'No such file: a.txt'))
    expect(file).toBeInstanceOf(WorkspaceFileError)
    expect(file).toMatchObject({ code: 'not-found', status: 404, message: 'No such file: a.txt' })

    expect(crossed(new MemoryError('too big', 413))).toMatchObject({ status: 413, message: 'too big' })
    expect(crossed(new MemoryError('too big', 413))).toBeInstanceOf(MemoryError)

    const config = crossed(new ConfigDocError('conflict', 'secrets', 'kept losing'))
    expect(config).toBeInstanceOf(ConfigDocError)
    expect(config).toMatchObject({ code: 'conflict', docId: 'secrets', message: 'The secrets document kept losing' })

    const start = crossed(new StartError('attach-failed', true, 'stream did not attach'))
    expect(start).toBeInstanceOf(StartError)
    expect(start).toMatchObject({ code: 'attach-failed', revoked: true })
  })

  it('carries the cause chain, so a runtime error under a delivery failure still answers its HTTP response', async () => {
    const reconnect = new ProviderReconnectRequiredError('Reconnect Claude')
    const error = crossed(new DeliveryError('unavailable', 'could not reach the provider', { cause: reconnect, status: 424 }))

    expect(deliveryFailure(error)).toEqual({ code: 'unavailable', accepted: false, status: 424 })
    const runtime = findAgentRuntimeError(error)
    expect(runtime).toBeInstanceOf(ProviderReconnectRequiredError)
    const response = runtime!.toHttpResponse()
    expect(response.status).toBe(424)
    expect(await response.json()).toMatchObject({ code: 'provider_reconnect_required', error: 'Reconnect Claude' })
  })

  it('keeps the name and data fields of an error it does not know, and drops what is not data', () => {
    const odd = Object.assign(new Error('boom'), { name: 'OddError', code: 'ODD', detail: { at: 3 }, callback: () => 1 })
    const error = crossed(odd)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'OddError', message: 'boom', code: 'ODD', detail: { at: 3 } })
    expect(error).not.toHaveProperty('callback')
    expect(crossed('just a string')).toMatchObject({ message: 'just a string' })
    expect(crossed(() => 1)).toMatchObject({ message: '() => 1', cause: undefined })
  })

  it('keeps where the actor threw it', () => {
    const thrown = new WorkspaceFileError('not-found')
    expect(crossed(thrown).stack).toBe(thrown.stack)
  })
})

describe('serializingActor', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands each side its own copy: neither the arguments nor the result are shared', async () => {
    const held = { tags: ['a'] }
    const actor = serializingActor(actorOf({
      sessions: {
        updateMetadata: async (_id: string, updates: { tags: string[] }) => {
          held.tags = updates.tags
          return held
        },
      },
    }))
    const updates = { tags: ['b'] }
    const result = await actor.sessions.updateMetadata('s', updates as never) as unknown as { tags: string[] }

    updates.tags.push('changed by the caller')
    result.tags.push('changed by the caller')
    expect(held.tags).toEqual(['b'])
  })

  it('refuses a function on either side', async () => {
    const actor = serializingActor(actorOf({
      messages: { findLastEntry: async () => ({ callback: () => 1 }) },
      sessions: { list: async () => [] },
    }))
    await expect(actor.sessions.list((() => true) as never)).rejects.toThrow(/sessions\.list argument cannot cross/)
    await expect(actor.messages.findLastEntry('s', { kind: 'assistant' })).rejects.toThrow(/messages\.findLastEntry result\.callback cannot cross/)
  })

  it('yields to the event loop before and after the call', async () => {
    const order: string[] = []
    const actor = serializingActor(actorOf({ sessions: { exists: async () => { order.push('op'); return true } } }))
    const call = actor.sessions.exists('s').then(() => order.push('result'))
    setImmediate(() => order.push('a macrotask queued with the call'))
    await call
    expect(order).toEqual(['a macrotask queued with the call', 'op', 'result'])
  })

  it('does not stall under fake timers', async () => {
    vi.useFakeTimers()
    const actor = serializingActor(actorOf({ sessions: { exists: async () => true } }))
    await expect(actor.sessions.exists('s')).resolves.toBe(true)
  })

  it('throws what the actor threw, rebuilt on the caller\'s side', async () => {
    const actor = serializingActor(actorOf({
      files: { stat: async () => { throw new WorkspaceFileError('not-a-file') } },
    }))
    const error = await actor.files.stat('dir').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(WorkspaceFileError)
    expect(error).toMatchObject({ code: 'not-a-file', status: 404 })
  })

  it('passes the read\'s advisory signal and the container transport as they are, and reaches nested groups', async () => {
    const response = new Response('ok')
    const signal = new AbortController().signal
    let given: AbortSignal | undefined
    const actor = serializingActor(actorOf({
      messages: { media: async (_s: string, _ref: unknown, received: AbortSignal) => { given = received; return undefined } },
      container: { fetch: async () => response },
      inputs: { reviews: { get: async (id: string) => ({ id }) } },
    }, async () => ({ activeSessionIds: ['s'] })))

    await actor.messages.media('s', { kind: 'x' } as never, signal)
    expect(given).toBe(signal)
    expect(await actor.container.fetch('/health')).toBe(response)
    expect(await actor.inputs.reviews.get('r1')).toEqual({ id: 'r1' })
    expect(await actor.live()).toEqual({ activeSessionIds: ['s'] })
    expect(actor.slug).toBe('a')
  })

  it('refuses a signal to any op but the pure reads that take one', async () => {
    const actor = serializingActor(actorOf({ sessions: { list: async () => [] } }))
    await expect(actor.sessions.list({ signal: new AbortController().signal } as never)).rejects.toThrow(/sessions\.list argument\.signal cannot cross/)
  })

  it('carries a stream\'s chunks as copies, and fails a stream whose chunk is not data', async () => {
    const sent = { type: 'stream_start' }
    const actor = serializingActor(actorOf({
      messages: {
        subscribe: async () => new ReadableStream({ start: (c) => { c.enqueue(sent); c.enqueue({ type: 'odd', callback: () => 1 }); c.close() } }),
      },
    }))
    const reader = (await actor.messages.subscribe('s')).getReader()

    const first = await reader.read()
    expect(first.value).toEqual(sent)
    expect(first.value).not.toBe(sent)
    await expect(reader.read()).rejects.toThrow(/messages\.subscribe result stream chunk cannot cross/)
  })

  it('lets the actor\'s side of a stream go when the caller cancels it', async () => {
    const cancelled = vi.fn()
    const actor = serializingActor(actorOf({
      messages: { subscribe: async () => new ReadableStream({ cancel: cancelled }) },
    }))
    await (await actor.messages.subscribe('s')).cancel()
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled())
  })

  it('hands out no instance of the actor\'s classes: a shortcut for a local one is not taken', async () => {
    class LocalFiles {
      async stat() { return { kind: 'file' } }
    }
    const actor = serializingActor(actorOf({ files: new LocalFiles() as unknown as Record<string, unknown> }))
    expect(actor.files instanceof LocalFiles).toBe(false)
    expect(await actor.files.stat('x')).toEqual({ kind: 'file' })
  })

  it('reports an op that throws instead of rejecting', async () => {
    const actor = serializingActor(actorOf({ sessions: { exists: () => { throw new Error('not async') } } }))
    const error = await actor.sessions.exists('s').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TypeError)
    expect(error).toMatchObject({ message: 'sessions.exists threw instead of rejecting', cause: { message: 'not async' } })
  })

  it('looks each op up when it is called, so a replaced op is the one that runs', async () => {
    const inner = actorOf({ sessions: { exists: async () => false } })
    const actor = serializingActor(inner)
    vi.spyOn(inner.sessions, 'exists').mockResolvedValue(true)
    expect(await actor.sessions.exists('s')).toBe(true)
  })
})
