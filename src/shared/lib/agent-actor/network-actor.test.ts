import { describe, expect, it, vi } from 'vitest'
import { remoteActor, serveActor, type ActorFetch } from './network-actor'
import { WorkspaceFileError } from './workspace-path'
import type { AgentActor } from './types'

const bytes = (text: string) => new TextEncoder().encode(text)
const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text()

/** An actor double with just the ops these tests call. */
function fakeActor() {
  const written: string[] = []
  const actor = {
    slug: 'sales-agent',
    live: vi.fn(async () => ({ activeSessionIds: ['s1'], awaitingSessionIds: [], openRequests: [], pendingReviews: [] })),
    sessions: {
      list: vi.fn(async () => [{ id: 's1', name: undefined, createdAt: new Date('2026-10-27T12:00:00Z'), tags: new Set(['a']) }]),
    },
    messages: {
      page: vi.fn(async (_id: string, opts: { signal?: AbortSignal }) => {
        await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }))
        return { aborted: opts.signal?.aborted ?? false }
      }),
    },
    files: {
      read: vi.fn(async () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes('hello '))
          controller.enqueue(bytes('world'))
          controller.close()
        },
      })),
      write: vi.fn(async (_path: string, body: ReadableStream<Uint8Array>) => {
        const got = await text(body)
        written.push(got)
        return { size: got.length }
      }),
      stat: vi.fn(async () => {
        throw new WorkspaceFileError('not_found', 'notes.md does not exist')
      }),
      list: vi.fn(() => {
        throw new Error('sync throw')
      }),
    },
    inputs: { reviews: { list: vi.fn(async () => new Map([['r1', { displayText: 'GET /v1/me' }]])) } },
    container: {
      fetch: vi.fn(async (path: string, init?: RequestInit) =>
        Response.json({ path, method: init?.method, body: init?.body ? await new Response(init.body).text() : null })),
    },
  }
  return { actor, written }
}

function connect(actor: object): { remote: AgentActor; send: ActorFetch } {
  const send = serveActor(() => actor as unknown as AgentActor)
  return { remote: remoteActor('sales-agent', send), send }
}

describe('network actor', () => {
  it('carries results that structured clone keeps: undefined, Date, Set, Map', async () => {
    const { actor } = fakeActor()
    const { remote } = connect(actor)

    const [session] = await remote.sessions.list() as unknown as Array<{ name: undefined; createdAt: Date; tags: Set<string> }>
    expect(session).toEqual({ id: 's1', name: undefined, createdAt: new Date('2026-10-27T12:00:00Z'), tags: new Set(['a']) })
    expect('name' in session).toBe(true)

    expect(await (remote.inputs.reviews as unknown as { list(): Promise<Map<string, unknown>> }).list()).toEqual(new Map([['r1', { displayText: 'GET /v1/me' }]]))
    expect(await remote.live()).toMatchObject({ activeSessionIds: ['s1'] })
  })

  it('streams a result body and a streamed argument', async () => {
    const { actor, written } = fakeActor()
    const { remote } = connect(actor)

    expect(await text(await remote.files.read('notes.md'))).toBe('hello world')

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes('line 1\n'))
        controller.enqueue(bytes('line 2\n'))
        controller.close()
      },
    })
    expect(await remote.files.write('notes.md', body)).toEqual({ size: 14 })
    expect(written).toEqual(['line 1\nline 2\n'])
  })

  it('rebuilds a thrown error as its own class, and turns a sync throw into a rejection', async () => {
    const { actor } = fakeActor()
    const { remote } = connect(actor)

    const error = await remote.files.stat('notes.md').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WorkspaceFileError)
    expect(error).toMatchObject({ code: 'not_found', message: 'notes.md does not exist' })

    await expect(remote.files.list('')).rejects.toThrow('files.list threw instead of rejecting')
  })

  it("aborts a pure read through the request's own signal", async () => {
    const { actor } = fakeActor()
    const { remote } = connect(actor)
    const controller = new AbortController()

    const page = remote.messages.page('s1', { limit: 10, signal: controller.signal })
    await vi.waitFor(() => expect(actor.messages.page).toHaveBeenCalled())
    controller.abort()

    // Advisory, as on the serializing transport: the read settles; over a real socket fetch rejects instead.
    await page.catch(() => {})
    expect((actor.messages.page.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true)
  })

  it('refuses a signal on an op that is not a pure read, before sending anything', async () => {
    const { actor } = fakeActor()
    const { remote } = connect(actor)
    await expect(remote.sessions.list({ signal: new AbortController().signal } as never)).rejects.toThrow('an AbortSignal is passed only to a pure read')
    expect(actor.sessions.list).not.toHaveBeenCalled()
  })

  it('pipes container.fetch as plain HTTP', async () => {
    const { actor } = fakeActor()
    const { remote } = connect(actor)

    const response = await remote.container.fetch('/inputs/pending', { method: 'POST', body: '{"a":1}' })
    expect(await response.json()).toEqual({ path: '/inputs/pending', method: 'POST', body: '{"a":1}' })
  })

  it("hands the container the caller's own init: a string body stays a string, no init stays none", async () => {
    const { actor } = fakeActor()
    const { remote } = connect(actor)

    await remote.container.fetch('/browser/fill', { method: 'POST', body: '{"a":1}', redirect: 'manual', headers: { 'x-trace': '1' } })
    expect(actor.container.fetch).toHaveBeenLastCalledWith('/browser/fill', { method: 'POST', body: '{"a":1}', redirect: 'manual', headers: { 'x-trace': '1' } })

    await remote.container.fetch('/health')
    expect(actor.container.fetch).toHaveBeenLastCalledWith('/health')
  })

  it('answers only ops on actor groups', async () => {
    const { actor } = fakeActor()
    const { send } = connect(actor)
    const post = (path: string) => send(new Request(`http://actor/agents/sales-agent/op/${path}`, { method: 'POST', body: '{"v":[]}\n' }))

    expect((await post('files.constructor')).status).toBe(404)
    expect((await post('files.__proto__')).status).toBe(404)
    expect((await post('slug.toString')).status).toBe(404)
    expect((await post('files.missing')).status).toBe(404)
    expect((await post('files.read')).status).toBe(200)
  })
})
