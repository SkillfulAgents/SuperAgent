import { describe, expect, it, vi } from 'vitest'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import type { AgentActor } from '@shared/lib/agent-actor/types'
import { cloudflareAgentActor, runActorOp, type ActorObject } from './cloudflare-agent-actor'

/** The actor in the agent's object, reached the way RPC reaches it: arguments and results are cloned. */
function overRpc(actor: Partial<Record<string, unknown>>) {
  const calls: Array<{ path: string; args: unknown[] }> = []
  const object: ActorObject = {
    actorCall: async (path, args) => {
      calls.push({ path, args })
      const cloned = path === 'container.fetch' ? args : structuredClone(args)
      const outcome = await runActorOp(actor as unknown as AgentActor, path, cloned)
      if (path === 'container.fetch') return outcome
      // A stream crosses RPC only when it is a byte stream; it is transferred, not cloned.
      if ('value' in outcome && outcome.value instanceof ReadableStream) {
        outcome.value.getReader({ mode: 'byob' }).releaseLock()
        return outcome
      }
      return structuredClone(outcome)
    },
  }
  return { client: cloudflareAgentActor('sales-agent', (run) => run(object)), calls }
}

describe('cloudflareAgentActor', () => {
  it("runs an op on the agent's actor and gets its value back, dates and maps included", async () => {
    const lastActivityAt = new Date('2026-11-06T18:00:00Z')
    const { client } = overRpc({ sessions: { summary: async () => ({ sessionIds: ['s1'], sessionCount: 1, lastActivityAt, byDay: new Map([['2026-11-06', 3]]) }) } })

    const summary = (await client.sessions.summary()) as unknown as { lastActivityAt: Date; byDay: Map<string, number> }

    expect(summary.lastActivityAt).toEqual(lastActivityAt)
    expect(summary.byDay.get('2026-11-06')).toBe(3)
  })

  it("reaches the agent's listing, an op of the actor itself", async () => {
    const listing = vi.fn(async () => ({ refreshingWidgets: ['next-meeting'] }))
    const { client, calls } = overRpc({ listing })

    expect(await client.listing()).toEqual({ refreshingWidgets: ['next-meeting'] })
    expect(calls[0].path).toBe('listing')
  })

  it('reaches ops in nested groups', async () => {
    const pending = vi.fn(async () => ['review-1'])
    const { client, calls } = overRpc({ inputs: { reviews: { pending } } })

    expect(await (client.inputs.reviews as unknown as { pending(): Promise<string[]> }).pending()).toEqual(['review-1'])
    expect(calls[0].path).toBe('inputs.reviews.pending')
  })

  it('keeps the class of an error the actor throws, so callers can still branch on it', async () => {
    const { client } = overRpc({ files: { getDoc: async () => { throw new WorkspaceFileError('not-found') } } })

    const error = await client.files.getDoc('notes/q3.md').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(WorkspaceFileError)
    expect((error as WorkspaceFileError).code).toBe('not-found')
  })

  it('leaves an AbortSignal behind, since it cannot cross RPC', async () => {
    const page = vi.fn(async () => ({ messages: [] }))
    const { client, calls } = overRpc({ messages: { page } })

    await client.messages.page('s1', { limit: 50, signal: new AbortController().signal } as never)

    expect(calls[0].args).toEqual(['s1', { limit: 50 }])
  })

  it("passes container.fetch's method, headers and body through, and returns the container's response", async () => {
    const fetch = vi.fn(async (path: string, init?: RequestInit) => new Response(`${init?.method} ${path} ${await new Response(init?.body).text()} ${new Headers(init?.headers).get('x-agent')}`))
    const { client } = overRpc({ container: { fetch } })

    const response = await client.container.fetch('/files/notes.md/upload', { method: 'POST', headers: { 'x-agent': 'sales' }, body: 'Q3 pipeline' })

    expect(await response.text()).toBe('POST /files/notes.md/upload Q3 pipeline sales')
  })

  it("sends a viewer's frames as a byte stream and hands them back as frames", async () => {
    const frames = [{ id: '1', data: '{"type":"snapshot"}' }, { id: '2', data: '{"type":"ping"}' }]
    const { client } = overRpc({ messages: { follow: async () => new ReadableStream({ start: (controller) => { for (const frame of frames) controller.enqueue(frame); controller.close() } }) } })

    const stream = await client.messages.follow('s1', {})

    expect(await Array.fromAsync(stream as unknown as AsyncIterable<unknown>)).toEqual(frames)
  })

  it("cancels the agent's stream when the viewer stops reading", async () => {
    const cancel = vi.fn()
    const { client } = overRpc({ messages: { subscribe: async () => new ReadableStream({ pull: (controller) => controller.enqueue({ type: 'ping' }), cancel }) } })

    const stream = await client.messages.subscribe('s1')
    const reader = stream.getReader()
    expect(await reader.read()).toEqual({ done: false, value: { type: 'ping' } })
    await reader.cancel()

    await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
  })

  it('refuses a path that is not an op on an actor group', async () => {
    const { client } = overRpc({ sessions: {} })

    await expect((client as unknown as { sessions: { constructor(): Promise<unknown> } }).sessions.constructor()).rejects.toThrow('No actor op sessions.constructor')
    await expect(runActorOp({} as AgentActor, '__proto__.x', [])).resolves.toMatchObject({ error: expect.anything() })
  })
})
