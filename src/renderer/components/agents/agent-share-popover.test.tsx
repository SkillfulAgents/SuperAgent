// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const state = vi.hoisted(() => ({
  members: [] as Array<Record<string, unknown>>,
  candidates: [] as Array<Record<string, unknown>>,
  posts: [] as Array<{ url: string; body: unknown }>,
}))

vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ user: { id: 'ada' }, isAuthMode: true }) }))
vi.mock('@renderer/hooks/use-agent-members', () => ({
  useAgentMembers: () => ({ data: state.members, isLoading: false, isError: false, refetch: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useAgentTemplateStatus: () => ({ data: undefined, isPending: true, isError: false }),
  useExportAgentTemplate: () => ({ mutate: vi.fn(), isPending: false }),
  useExportAgentFull: () => ({ mutate: vi.fn(), isPending: false }),
  useHostExportStatus: () => ({ data: undefined }),
}))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      state.posts.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ ok: true }), { status: 201 })
    }
    return new Response(JSON.stringify(state.candidates))
  }),
}))

import { AgentSharePopover } from './agent-share-popover'

function renderPopover() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AgentSharePopover agentSlug="support" agentName="Support" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.posts = []
  state.members = [
    { id: 'ada', name: 'Ada Admin', email: 'ada@acme.test', image: null, role: 'owner' },
    { id: 'lee', name: 'Lee Park', email: 'lee@acme.test', image: null, role: 'user', invited: true },
  ]
  state.candidates = [
    { kind: 'user', id: 'dan-id', name: 'Dan Ortiz', email: 'dan@acme.test', image: null, notOnGamut: false },
    { kind: 'directory', directoryRef: { directoryId: 'dir-1', remoteId: 'U7' }, name: 'Dana Whitfield', email: 'dana@acme.test', image: null, notOnGamut: true, source: 'Slack · Acme' },
  ]
})
afterEach(cleanup)

describe('sharing an agent with people not on Gamut yet', () => {
  it('marks members who have not joined as invite pending', async () => {
    renderPopover()
    await userEvent.click(screen.getByTestId('agent-share-button'))
    const lee = await screen.findByTestId('access-entry-lee')
    expect(within(lee).getByTestId('not-on-gamut-badge')).toHaveTextContent('Invite pending')
    expect(within(screen.getByTestId('access-entry-ada')).queryByTestId('not-on-gamut-badge')).toBeNull()
  })

  it('finds directory people, marked as not on Gamut, and invites them by their directory reference', async () => {
    renderPopover()
    await userEvent.click(screen.getByTestId('agent-share-button'))
    await userEvent.type(screen.getByTestId('invite-search-input'), 'dan')

    const dana = await screen.findByTestId('invite-user-result-directory:dir-1:U7')
    expect(dana).toHaveTextContent('Not on Gamut')
    expect(dana).toHaveTextContent('dana@acme.test · Slack · Acme')
    expect(within(screen.getByTestId('invite-user-result-dan-id')).queryByTestId('not-on-gamut-badge')).toBeNull()

    await userEvent.click(dana)
    await userEvent.type(screen.getByTestId('invite-search-input'), 'dan')
    await userEvent.click(await screen.findByTestId('invite-user-result-dan-id'))
    await userEvent.click(screen.getByTestId('invite-add-button'))

    await waitFor(() => expect(state.posts).toEqual([
      { url: '/api/agents/support/access', body: { directoryRef: { directoryId: 'dir-1', remoteId: 'U7' }, role: 'user' } },
      { url: '/api/agents/support/access', body: { userId: 'dan-id', role: 'user' } },
    ]))
  })
})
