// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { loadAgentMembers } from '@renderer/lib/agent-members-loader'
import { MAX_AGENT_MEMBERS_BATCH_SIZE } from '@shared/lib/agent-members-schema'
import { useAgentMembers } from './use-agent-members'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true }) }))
const member = { id: 'person', name: 'Ada', email: 'ada@example.test', image: null, role: 'owner' }
const clients: QueryClient[] = []
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, wrapper }
}
function fetchRoster(client: QueryClient, slug: string) {
  return client.fetchQuery({ queryKey: ['agent-members', slug], queryFn: ({ signal }) => loadAgentMembers(client, slug, signal) })
}
function requestedBatches(): string[][] {
  return vi.mocked(apiFetch).mock.calls.map(([, init]) => JSON.parse(init!.body as string).agentSlugs)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    const { agentSlugs } = JSON.parse(init!.body as string) as { agentSlugs: string[] }
    return response(Object.fromEntries(agentSlugs.map(slug => [slug, { status: 200, members: [member] }])))
  })
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

describe('batched roster queries', () => {
  it('shares one request across rows and the header, and batches broad invalidations', async () => {
    const { client, wrapper } = setup()
    const { result } = renderHook(() => ({
      first: useAgentMembers('first'),
      second: useAgentMembers('second'),
      header: useAgentMembers('first'),
      privateAgent: useAgentMembers('private', false),
    }), { wrapper })
    await waitFor(() => expect(result.current.second.isSuccess).toBe(true))
    expect(result.current.first.data).toEqual([member])
    expect(result.current.header.data).toEqual([member])
    expect(requestedBatches()).toEqual([['first', 'second']])
    expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/api/agents/members/batch')

    await act(() => client.invalidateQueries({ queryKey: ['agent-members'] }))
    expect(requestedBatches()).toEqual([['first', 'second'], ['first', 'second']])
    await act(() => client.invalidateQueries({ queryKey: ['agent-members', 'second'] }))
    expect(requestedBatches().at(-1)).toEqual(['second'])

    renderHook(() => useAgentMembers('first'), { wrapper })
    expect(apiFetch).toHaveBeenCalledTimes(3) // The fresh per-agent cache is reusable.
  })

  it('keeps an inaccessible roster from failing an authorized sibling', async () => {
    vi.mocked(apiFetch).mockResolvedValue(response({ first: { status: 200, members: [member] }, second: { status: 403 } }))
    const { wrapper } = setup()
    const { result } = renderHook(() => ({ first: useAgentMembers('first'), second: useAgentMembers('second') }), { wrapper })
    await waitFor(() => expect(result.current.second.isError).toBe(true))
    expect(result.current.first.data).toEqual([member])
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('cancels a revoked roster without cancelling its sibling or restoring revoked cache data', async () => {
    let finish!: (value: Response) => void
    vi.mocked(apiFetch).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const { client } = setup()
    const revoked = fetchRoster(client, 'revoked').catch(() => undefined)
    const kept = fetchRoster(client, 'kept')
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    await client.cancelQueries({ queryKey: ['agent-members', 'revoked'] })
    client.removeQueries({ queryKey: ['agent-members', 'revoked'] })
    expect(vi.mocked(apiFetch).mock.calls[0][1]?.signal?.aborted).toBe(false)
    finish(response({ revoked: { status: 200, members: [member] }, kept: { status: 200, members: [member] } }))
    await expect(kept).resolves.toEqual([member])
    await revoked
    expect(client.getQueryData(['agent-members', 'revoked'])).toBeUndefined()
  })

  it('aborts shared work on cache clear and excludes cancelled work before dispatch', async () => {
    const { client } = setup()
    const queued = fetchRoster(client, 'queued').catch(() => undefined)
    client.clear()
    await queued
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(apiFetch).not.toHaveBeenCalled()

    vi.mocked(apiFetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const pending = [fetchRoster(client, 'first'), fetchRoster(client, 'second')].map(promise => promise.catch(() => undefined))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    client.clear()
    await Promise.all(pending)
    expect(vi.mocked(apiFetch).mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })

  it('keeps different query clients isolated', async () => {
    const first = setup().client
    const second = setup().client
    await Promise.all([fetchRoster(first, 'first'), fetchRoster(second, 'second')])
    expect(requestedBatches()).toEqual([['first'], ['second']])
  })

  it('splits large sidebars into bounded batches', async () => {
    const { client } = setup()
    await Promise.all(Array.from({ length: MAX_AGENT_MEMBERS_BATCH_SIZE + 1 }, (_, i) => fetchRoster(client, `agent-${i}`)))
    expect(requestedBatches().map(batch => batch.length)).toEqual([MAX_AGENT_MEMBERS_BATCH_SIZE, 1])
  })

  it.each([{}, { first: { status: 200, members: [{ ...member, role: 'invalid' }] } }])(
    'rejects missing or malformed batch results', async body => {
      vi.mocked(apiFetch).mockResolvedValue(response(body))
      const { client } = setup()
      await expect(fetchRoster(client, 'first')).rejects.toThrow()
      expect(client.getQueryData(['agent-members', 'first'])).toBeUndefined()
    },
  )

  it('surfaces transport errors to all affected queries', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('Network failed'))
    const { client } = setup()
    const results = await Promise.allSettled([fetchRoster(client, 'first'), fetchRoster(client, 'second')])
    expect(results.every(result => result.status === 'rejected')).toBe(true)
  })
})
