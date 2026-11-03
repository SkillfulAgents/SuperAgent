// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))

const github = { id: 'github-com-acme-skills', url: 'https://github.com/acme/skills', name: 'Acme', provider: 'github' }
const ops = { skillsetId: github.id, path: 'agents/ops/', name: 'Ops' }
const teamBrain = { skillsetId: DEFAULT_PUBLIC_SKILLSET.id, path: 'agents/team-brain/', name: 'Team Brain' }

// The server: a workspace with one GitHub skillset; the add puts the public one beside it.
let added: boolean
let refreshed: boolean
let releaseRefresh: () => void
beforeEach(() => {
  added = false
  refreshed = false
  const refreshDone = new Promise<void>((resolve) => { releaseRefresh = resolve })
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    const opsNow = () => (refreshed ? { ...ops, name: 'Ops v2' } : ops)
    const catalog = () => new Response(JSON.stringify({ agents: added ? [opsNow(), teamBrain] : [opsNow()] }))
    if (url === '/api/skillsets' && init?.method === 'POST') {
      added = true
      return new Response(JSON.stringify(DEFAULT_PUBLIC_SKILLSET), { status: 201 })
    }
    if (url === '/api/skillsets') return new Response(JSON.stringify(added ? [github, DEFAULT_PUBLIC_SKILLSET] : [github]))
    // The once-per-session refresh answers with the skillsets it started from: Acme updated upstream, no public skillset.
    if (url === '/api/agents/discoverable-agents?refresh=true') {
      await refreshDone
      refreshed = true
      return new Response(JSON.stringify({ agents: [{ ...ops, name: 'Ops v2' }] }))
    }
    if (url === '/api/agents/discoverable-agents') return catalog()
    throw new Error(`unexpected ${url}`)
  })
  vi.resetModules()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function mount() {
  const { useDiscoverableAgents } = await import('./use-agent-templates')
  const { useAddSkillset } = await import('./use-skillsets')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const view = renderHook(() => ({ templates: useDiscoverableAgents(), add: useAddSkillset() }), { wrapper })
  await waitFor(() => expect(view.result.current.templates.data).toBeDefined())
  const teamBrainTemplate = () => view.result.current.templates.data?.find((t) => t.skillsetId === DEFAULT_PUBLIC_SKILLSET.id)
  return { ...view, client, teamBrainTemplate }
}

it('shows an added skillset’s templates on a screen that stays open', async () => {
  const { result, client, teamBrainTemplate } = await mount()
  expect(teamBrainTemplate()).toBeUndefined()
  await act(async () => { await result.current.add.mutateAsync({ url: DEFAULT_PUBLIC_SKILLSET.url }) })
  await waitFor(() => expect(teamBrainTemplate()).toBeDefined())
  releaseRefresh()
  client.clear()
})

it('keeps an add made while the first background refresh runs, and still shows what the refresh pulled', async () => {
  const { result, client, teamBrainTemplate } = await mount()
  await act(async () => { await result.current.add.mutateAsync({ url: DEFAULT_PUBLIC_SKILLSET.url }) })
  await waitFor(() => expect(teamBrainTemplate()).toBeDefined())
  // What the catalog holds at the moment the refresh reports done: it must already be final.
  let atDone: string[] | undefined
  const stop = client.getQueryCache().subscribe(({ query }) => {
    if (query.queryKey[0] === 'discoverable-agents-refresh' && query.state.data === 'done' && !atDone) {
      atDone = client.getQueryData<Array<{ name: string }>>(['discoverable-agents'])?.map((t) => t.name)
    }
  })
  await act(async () => { releaseRefresh() })
  await waitFor(() => expect(atDone).toBeDefined())
  stop()
  expect(atDone).toEqual(['Ops v2', 'Team Brain'])
  client.clear()
})
