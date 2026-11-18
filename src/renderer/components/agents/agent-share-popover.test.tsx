// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const state = vi.hoisted(() => ({
  members: [] as Array<Record<string, unknown>>,
  candidates: [] as Array<Record<string, unknown>>,
  posts: [] as Array<{ url: string; body: unknown }>,
  authMode: true,
  agents: [] as Array<Record<string, unknown>>,
  agentRoles: [] as Array<{ slug: unknown; role: string | null }>,
  blocked: [] as Array<{ slug: string; displaySlug: string; name: string; avatar: null; canAccess: boolean; blocks: Array<{ callerSlug: string; operation: 'read' | 'invoke' }> }> | undefined,
  fullExport: { mutate: vi.fn(), isPending: false },
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    user: state.authMode ? { id: 'ada' } : null,
    isAuthMode: state.authMode,
    canUseAgent: (slug: string) => slug !== 'not-mine',
  }),
}))
vi.mock('@renderer/hooks/use-inbound-x-agent', () => {
  const record = async ({ callerSlug, change }: { callerSlug: string; change: string }) => {
    state.agentRoles.push({ slug: callerSlug, role: change })
  }
  return {
    useInboundXAgentDetails: () => ({ data: { sessions: [], callers: state.agents, blocked: state.blocked }, isLoading: false }),
    useSetAgentAccess: () => ({ mutate: record, mutateAsync: record }),
  }
})
vi.mock('@renderer/hooks/use-agent-members', () => ({
  useAgentMembers: () => ({ data: state.members, isLoading: false, isError: false, refetch: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useAgentTemplateStatus: () => ({ data: undefined, isPending: true, isError: false }),
  useExportAgentTemplate: () => ({ mutate: vi.fn(), isPending: false }),
  useExportAgentFull: () => state.fullExport,
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

import { AgentSharePopover, agentAccessChange } from './agent-share-popover'

function renderPopover() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AgentSharePopover agentSlug="support" agentName="Support" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.posts = []
  state.authMode = true
  state.agentRoles = []
  state.blocked = []
  state.agents = [
    { slug: 'triage', displaySlug: 'inbox-triage', name: 'Inbox Triage', decision: 'allow', readDecision: 'review', avatar: null, canAccess: true },
    { slug: 'notes', displaySlug: 'release-notes', name: 'Release Notes', decision: 'review', readDecision: 'allow', avatar: null, canAccess: true },
    { slug: 'danube', displaySlug: 'danube', name: 'Danube Ops', decision: 'review', readDecision: 'review', avatar: null, canAccess: true },
    { slug: 'not-mine', displaySlug: 'dan-private', name: 'Dan Private', decision: 'review', readDecision: 'review', avatar: null, canAccess: true },
    { slug: 'dam', displaySlug: 'dam-walled', name: 'Dam Walled', decision: 'allow', readDecision: 'block', avatar: null, canAccess: true },
  ]
  state.fullExport = { mutate: vi.fn(), isPending: false }
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

describe('sharing an agent with other agents', () => {
  it('lists agents with access after the people, in the roles people have', async () => {
    renderPopover()
    await userEvent.click(screen.getByTestId('agent-share-button'))

    expect(await screen.findByTestId('access-agent-triage')).toHaveTextContent('Inbox TriageReading asks firstUser')
    expect(screen.getByTestId('access-agent-notes')).toHaveTextContent('Release NotesAgentViewer')
    // Its own setting blocks reading every agent, but messaging this one still works, so it stays listed to revoke.
    expect(screen.getByTestId('access-agent-dam')).toHaveTextContent('Dam WalledReading blockedUser')
    // An agent that still asks first is not a member.
    expect(screen.queryByTestId('access-agent-danube')).toBeNull()
    const rows = screen.getAllByTestId(/^access-(entry|agent)-(?!role-)/).map((row) => row.getAttribute('data-testid'))
    expect(rows).toEqual(['access-entry-ada', 'access-entry-lee', 'access-agent-triage', 'access-agent-notes', 'access-agent-dam'])
  })

  it.each([
    ['its owner cannot message yet', 'allow'],
    ['its messaging is blocked for every agent', 'review'],
  ] as const)('saves Viewer when it is picked on a Viewer that can\'t message because %s', async (_case, decision) => {
    state.agents = [...state.agents, { slug: 'waiting', displaySlug: 'waiting', name: 'Waiting', decision, readDecision: 'allow', canMessage: false, avatar: null, canAccess: true }]
    renderPopover()
    await userEvent.click(screen.getByTestId('agent-share-button'))
    fireEvent.click(await screen.findByTestId('access-agent-role-waiting'))
    fireEvent.click(screen.getByRole('option', { name: /^Viewer/ }))

    await waitFor(() => expect(state.agentRoles).toEqual([{ slug: 'waiting', role: 'viewer' }]))
  })

  it('grants reading when User is picked on a User whose reading asks first', async () => {
    renderPopover()
    await userEvent.click(screen.getByTestId('agent-share-button'))
    fireEvent.click(await screen.findByTestId('access-agent-role-triage'))
    fireEvent.click(screen.getByRole('option', { name: /^User/ }))

    await waitFor(() => expect(state.agentRoles).toEqual([{ slug: 'triage', role: 'user' }]))
  })

  it('finds agents beside people and invites both in one batch', async () => {
    renderPopover()
    await userEvent.click(screen.getByTestId('agent-share-button'))
    await userEvent.type(screen.getByTestId('invite-search-input'), 'dan')

    // Linking two agents takes someone who uses both, so the other one is not offered. Nor is one whose own
    // setting blocks reading every agent: it can't become a member.
    expect(screen.queryByTestId('invite-agent-result-not-mine')).toBeNull()
    expect(screen.queryByTestId('invite-agent-result-dam')).toBeNull()
    await userEvent.click(await screen.findByTestId('invite-agent-result-danube'))
    expect(screen.getByTestId('invite-chip-agent:danube')).toHaveTextContent('Danube Ops')
    await userEvent.type(screen.getByTestId('invite-search-input'), 'dan')
    await userEvent.click(await screen.findByTestId('invite-user-result-dan-id'))
    await userEvent.click(screen.getByTestId('invite-add-button'))

    await waitFor(() => expect(state.agentRoles).toEqual([{ slug: 'danube', role: 'user' }]))
    expect(state.posts).toEqual([{ url: '/api/agents/support/access', body: { userId: 'dan-id', role: 'user' } }])
  })

  it('still invites agents on a local install, and points at Cloud for people', async () => {
    state.authMode = false
    renderPopover()
    await userEvent.click(screen.getByTestId('agent-share-button'))

    expect(await screen.findByTestId('access-entry-you')).toHaveTextContent('You')
    expect(screen.getByTestId('access-agent-triage')).toBeInTheDocument()
    expect(screen.getByTestId('agent-invite-cloud-row')).toHaveTextContent('Switch to Gamut Cloud')
    expect(screen.getByTestId('invite-search-input')).toHaveAttribute('placeholder', 'Invite agents...')
  })

  it('shows the role of an agent the viewer does not use, with nothing to change', async () => {
    state.agents = [...state.agents, { slug: 'not-mine', displaySlug: 'dan-private', name: 'Dan Private', decision: 'allow', readDecision: 'allow', avatar: null, canAccess: true }]
    renderPopover()
    await userEvent.click(screen.getByTestId('agent-share-button'))

    expect(await screen.findByTestId('access-agent-role-locked-not-mine')).toHaveTextContent('User')
    expect(screen.queryByTestId('access-agent-role-not-mine')).toBeNull()
  })

  it('lists people only on an older server, which cannot change an agent\'s role', async () => {
    state.blocked = undefined
    renderPopover()
    await userEvent.click(screen.getByTestId('agent-share-button'))
    await userEvent.type(await screen.findByTestId('invite-search-input'), 'dan')

    expect(await screen.findByTestId('invite-user-result-dan-id')).toBeInTheDocument()
    expect(screen.getByTestId('invite-search-input')).toHaveAttribute('placeholder', 'Invite people...')
    expect(screen.queryByTestId('invite-agent-result-danube')).toBeNull()
    expect(screen.queryByTestId('access-agent-triage')).toBeNull()
  })

  it('reads a role menu pick as the change it makes', () => {
    expect(['user', 'viewer', 'block', '__remove__', 'owner'].map(agentAccessChange)).toEqual(['user', 'viewer', 'block', 'remove', null])
  })

  it('keeps blocked agents out of the lists, folded under one line', async () => {
    state.blocked = [{ slug: 'triage', displaySlug: 'inbox-triage', name: 'Inbox Triage', avatar: null, canAccess: true, blocks: [{ callerSlug: 'triage', operation: 'invoke' }] }]
    renderPopover()
    await userEvent.click(screen.getByTestId('agent-share-button'))

    expect(await screen.findByTestId('access-blocked-toggle')).toHaveTextContent('1 blocked agent')
    expect(screen.queryByTestId('access-agent-triage')).toBeNull()
    expect(screen.queryByTestId('access-blocked-triage')).toBeNull()
    await userEvent.click(screen.getByTestId('access-blocked-toggle'))
    expect(screen.getByTestId('access-blocked-triage')).toHaveTextContent('Partly blockedBlocked')
  })
})

describe('full agent export confirmation', () => {
  async function openConfirm() {
    const view = renderPopover()
    await userEvent.click(screen.getByTestId('agent-share-button'))
    await userEvent.click(screen.getByRole('tab', { name: 'Export' }))
    await userEvent.click(screen.getByTestId('export-option-full'))
    await userEvent.click(screen.getByTestId('export-submit-button'))
    return view
  }

  it('keeps the dialog open after Export and closes it once the export settles', async () => {
    await openConfirm()
    await userEvent.click(screen.getByTestId('confirm-full-export-button'))

    expect(screen.getByText('Export Full Agent')).toBeInTheDocument()
    expect(state.fullExport.mutate).toHaveBeenCalledOnce()
    const [vars, callbacks] = state.fullExport.mutate.mock.calls[0]
    expect(vars).toMatchObject({ agentSlug: 'support', agentName: 'Support' })

    act(() => callbacks.onSettled())
    await waitFor(() => expect(screen.queryByText('Export Full Agent')).toBeNull())
  })

  it('shows progress and blocks dismissal while the export runs', async () => {
    const view = await openConfirm()
    await userEvent.click(screen.getByTestId('confirm-full-export-button'))
    const { onProgress } = state.fullExport.mutate.mock.calls[0][0]

    state.fullExport = { ...state.fullExport, isPending: true }
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <AgentSharePopover agentSlug="support" agentName="Support" />
      </QueryClientProvider>,
    )
    expect(screen.getByTestId('full-export-progress')).toHaveTextContent('Preparing export…')
    expect(screen.getByTestId('confirm-full-export-button')).toHaveTextContent('Exporting…')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    act(() => onProgress(3 * 1024 * 1024))
    expect(screen.getByTestId('full-export-progress')).toHaveTextContent('3.0 MB downloaded')

    await userEvent.keyboard('{Escape}')
    expect(screen.getByText('Export Full Agent')).toBeInTheDocument()
  })
})
