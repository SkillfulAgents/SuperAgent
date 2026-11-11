// @vitest-environment jsdom
/**
 * The full template catalog is a large read. Screens that only need to know
 * whether any template exists answer from the skillsets' own counts, and a
 * caller that needs the catalog only sometimes can turn the read off.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { apiFetch } from '@renderer/lib/api'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))

// Two configured skillsets: only the second ships agent templates.
const docs = { id: 'github-com-acme-docs', url: 'https://github.com/acme/docs', name: 'Docs', provider: 'github', skillCount: 4, agentCount: 0 }
const agents = { id: 'github-com-acme-agents', url: 'https://github.com/acme/agents', name: 'Agents', provider: 'github', skillCount: 0, agentCount: 3 }

let skillsets: unknown[]
beforeEach(() => {
  skillsets = [docs, agents]
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url === '/api/skillsets') return new Response(JSON.stringify(skillsets))
    if (url.startsWith('/api/agents/discoverable-agents')) return new Response(JSON.stringify({ agents: [] }))
    throw new Error(`unexpected ${url}`)
  })
  vi.resetModules()
})
afterEach(() => { cleanup() })

const catalogReads = () =>
  vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).startsWith('/api/agents/discoverable-agents')).length

async function mount<T>(useHook: (hooks: typeof import('./use-agent-templates')) => T) {
  const hooks = await import('./use-agent-templates')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { ...renderHook(() => useHook(hooks), { wrapper }), client }
}

it('answers that templates exist from the skillsets, without reading the catalog', async () => {
  const { result, client } = await mount((hooks) => hooks.useHasDiscoverableAgents())
  expect(result.current).toBeNull()
  await waitFor(() => expect(result.current).toBe(true))
  expect(catalogReads()).toBe(0)
  client.clear()
})

it('answers no when no skillset ships an agent template', async () => {
  skillsets = [docs]
  const { result, client } = await mount((hooks) => hooks.useHasDiscoverableAgents())
  await waitFor(() => expect(result.current).toBe(false))
  expect(catalogReads()).toBe(0)
  client.clear()
})

it('reads nothing from the catalog while disabled, and reads it once enabled', async () => {
  let enabled = false
  const { result, rerender, client } = await mount((hooks) => hooks.useDiscoverableAgents({ enabled }))
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/skillsets'))
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  expect(catalogReads()).toBe(0)

  enabled = true
  rerender()

  await waitFor(() => expect(result.current.data).toEqual([]))
  expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/agents/discoverable-agents')
  client.clear()
})
