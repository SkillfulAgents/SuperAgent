import { describe, expect, it, vi } from 'vitest'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import type { AgentActor } from '@shared/lib/agent-actor/types'
import { requestScopedSettings } from '@shared/lib/config/settings-request-memo'
import { getRequestUserId, runOutsideRequestUser, runWithRequestUser } from '@shared/lib/platform-attribution/request-context'
import type { AgentDurableObject } from './cloudflare-agent'
import { cloudflareAgentActor, ownedHere, runActorOp, runAsAgentObject, servingAgentObject, type ActorObject, type ActorOutcome } from './cloudflare-agent-actor'

/** The actor in the agent's object, reached the way RPC reaches it: arguments and results are cloned, and the caller's async context stays behind. */
function overRpc(actor: Partial<Record<string, unknown>>) {
  const calls: Array<{ path: string; args: unknown[] }> = []
  const object: ActorObject = {
    actorCall: async (path, args, _callerVersion, actingUserId) => {
      calls.push({ path, args })
      const cloned = path === 'container.fetch' ? args : structuredClone(args)
      const outcome = await runOutsideRequestUser(() => runActorOp(actor as unknown as AgentActor, path, cloned, actingUserId))
      if (path === 'container.fetch') return outcome
      // A stream crosses RPC only when it is a byte stream; it is transferred, not cloned.
      if ('value' in outcome && outcome.value instanceof ReadableStream) {
        outcome.value.getReader({ mode: 'byob' }).releaseLock()
        return outcome
      }
      return structuredClone(outcome)
    },
  }
  return { client: cloudflareAgentActor('sales-agent', async (run) => (await run(object)) as ActorOutcome), calls }
}

describe('cloudflareAgentActor', () => {
  it("runs an op on the agent's actor and gets its value back, dates and maps included", async () => {
    const lastActivityAt = new Date('2026-11-06T18:00:00Z')
    const { client } = overRpc({ sessions: { summary: async () => ({ sessionIds: ['s1'], sessionCount: 1, lastActivityAt, byDay: new Map([['2026-11-06', 3]]) }) } })

    const summary = (await client.sessions.summary()) as unknown as { lastActivityAt: Date; byDay: Map<string, number> }

    expect(summary.lastActivityAt).toEqual(lastActivityAt)
    expect(summary.byDay.get('2026-11-06')).toBe(3)
  })

  it("runs the actor's own calls, which belong to no group: its live state and its list entry", async () => {
    const live = vi.fn(async () => ({ containerStatus: 'running' }))
    const listing = vi.fn(async () => ({ sessionCount: 2, lastActivityAt: new Date('2026-11-06T18:00:00Z') }))
    const { client, calls } = overRpc({ live, listing })

    expect(await client.live()).toEqual({ containerStatus: 'running' })
    expect(await client.listing()).toEqual({ sessionCount: 2, lastActivityAt: new Date('2026-11-06T18:00:00Z') })
    expect(calls.map((call) => call.path)).toEqual(['live', 'listing'])
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

  it("runs the op for the user the caller's request acts for, and for no user when the caller has none", async () => {
    const { client } = overRpc({ sessions: { summary: async () => getRequestUserId() ?? null } })

    expect(await runWithRequestUser('user-1', () => client.sessions.summary())).toBe('user-1')
    expect(await client.sessions.summary()).toBeNull()
  })

  it("shares one settings read between an op's readers, and reads again for the next op", async () => {
    let reads = 0
    const read = async () => ({ read: ++reads })
    const { client } = overRpc({ sessions: { summary: async () => [await requestScopedSettings(read), await requestScopedSettings(read)] } })

    expect(await client.sessions.summary()).toEqual([{ read: 1 }, { read: 1 }])
    expect(await client.sessions.summary()).toEqual([{ read: 2 }, { read: 2 }])
  })

  it('refuses a path that is not an op on an actor group', async () => {
    const { client } = overRpc({ sessions: {} })

    await expect((client as unknown as { sessions: { constructor(): Promise<unknown> } }).sessions.constructor()).rejects.toThrow('No actor op sessions.constructor')
    await expect(runActorOp({} as AgentActor, '__proto__.x', [])).resolves.toMatchObject({ error: expect.anything() })
  })
})

describe('ownedHere', () => {
  const actor = (where: string) => ({ slug: 'sales-agent', files: { getDoc: async () => where } }) as unknown as AgentActor
  const object = {} as AgentDurableObject

  it("uses the actor in this isolate only inside the agent's own object, and the remote one everywhere else", async () => {
    const reached = ownedHere('sales-agent', actor('local'), actor('remote'))

    expect(await reached.files.getDoc('AGENTS.md')).toBe('remote')
    expect(await runAsAgentObject('sales-agent', object, () => reached.files.getDoc('AGENTS.md'))).toBe('local')
    expect(await runAsAgentObject('support-agent', object, () => reached.files.getDoc('AGENTS.md'))).toBe('remote')
  })

  it("keeps the agent's object for work its request starts later", async () => {
    const later = runAsAgentObject('sales-agent', object, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return servingAgentObject('sales-agent')
    })
    expect(await later).toBe(object)
    expect(servingAgentObject('sales-agent')).toBeNull()
  })
})
