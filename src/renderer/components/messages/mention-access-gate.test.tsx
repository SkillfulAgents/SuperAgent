// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { formatChipMarker } from '@renderer/lib/chip-marker'
import type { ChipContext } from './composer-chips'

const state = vi.hoisted(() => ({
  isAuthMode: true,
  canAdmin: true,
  members: [] as Array<{ id: string; name: string; email: string; image: null; role: 'owner' | 'user' | 'viewer' }>,
  policies: [] as Array<{ operation: string; targetAgentSlug: string | null; decision: string }>,
  requests: [] as Array<{ method: string; url: string; body?: unknown }>,
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: state.isAuthMode, isAdmin: false, canAdminAgent: () => state.canAdmin }),
}))
vi.mock('@renderer/lib/agent-members-loader', () => ({
  loadAgentMembers: async () => state.members,
}))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    state.requests.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (method === 'POST' && url.endsWith('/access')) {
      const { userId, role } = JSON.parse(String(init!.body))
      state.members.push({ id: userId, name: 'Sara Kim', email: 'sara@acme.com', image: null, role })
      return new Response(JSON.stringify({ ok: true }), { status: 201 })
    }
    if (url.endsWith('/x-agent-policies') && method === 'GET') return new Response(JSON.stringify({ policies: state.policies }))
    return new Response(JSON.stringify({ ok: true }))
  }),
}))

import { useMentionAccessGate } from './mention-access-gate'

const sara = formatChipMarker({ kind: 'user', referent: 'sara-id', label: 'Sara Kim' })
const mike = formatChipMarker({ kind: 'user', referent: 'mike-id', label: 'Mike Smith' })
const billing = formatChipMarker({ kind: 'agent', referent: 'billing01x', label: 'Billing Agent' })
const context: ChipContext = {
  agentSlug: 'support01x',
  agents: new Map([
    ['support01x', { slug: 'support01x', displaySlug: 'support-agent-support01x', name: 'Support Agent' }],
    ['billing01x', { slug: 'billing01x', displaySlug: 'billing-agent-billing01x', name: 'Billing Agent' }],
  ]),
}

let gate: ReturnType<typeof useMentionAccessGate>
function Harness() {
  gate = useMentionAccessGate('support01x')
  return <>{gate.dialog}</>
}

function confirm(content: string, silent = false) {
  let result: Promise<ChipContext | null>
  act(() => { result = gate.confirm(content, context, { silent }) })
  return result!
}

const writes = () => state.requests.filter((request) => request.method !== 'GET')

describe('useMentionAccessGate', () => {
  beforeAll(() => {
    HTMLElement.prototype.hasPointerCapture = () => false
    HTMLElement.prototype.scrollIntoView = () => {}
  })

  beforeEach(() => {
    state.isAuthMode = true
    state.canAdmin = true
    state.members = [{ id: 'mike-id', name: 'Mike Smith', email: 'mike@acme.com', image: null, role: 'user' }]
    state.policies = []
    state.requests = []
  })

  const mount = () => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Harness /></QueryClientProvider>,
  )

  it('sends at once when everyone tagged can see the agent', async () => {
    mount()
    await expect(confirm(`${mike} look`)).resolves.toBe(context)
    expect(screen.queryByTestId('mention-access-dialog')).toBeNull()
  })

  it('offers to share with a teammate who cannot open the agent, at the role picked', async () => {
    mount()
    const result = confirm(`${sara} look`)
    expect(await screen.findByText('Share this agent with Sara Kim?')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mention-share-role'))
    await userEvent.click(screen.getByRole('option', { name: /Viewer/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Share and send' }))

    const next = await result
    expect(writes()).toEqual([{ method: 'POST', url: '/api/agents/support01x/access', body: { userId: 'sara-id', role: 'viewer' } }])
    // Sent with the fresh roster, so the agent gets Sara's email.
    expect(next?.members?.get('sara-id')?.email).toBe('sara@acme.com')
  })

  it('sends nothing when the person cancels the share', async () => {
    mount()
    const result = confirm(`${sara} look`)
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    await expect(result).resolves.toBeNull()
    expect(writes()).toEqual([])
  })

  it('offers access to an agent this one cannot reach, and grants what was picked', async () => {
    mount()
    const result = confirm(`ask ${billing} for the numbers`)
    expect(await screen.findByText('Let Support Agent reach Billing Agent?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Allow and send' }))

    await expect(result).resolves.toBe(context)
    expect(writes().map((request) => request.body)).toEqual([
      { operation: 'read', targetSlug: 'billing01x', decision: 'allow' },
      { operation: 'invoke', targetSlug: 'billing01x', decision: 'allow' },
    ])
  })

  it('can leave it to the agent to ask each time', async () => {
    mount()
    const result = confirm(`ask ${billing}`)
    await userEvent.click(await screen.findByTestId('mention-reach-select'))
    await userEvent.click(screen.getByRole('option', { name: 'Ask me each time' }))
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    await expect(result).resolves.toBe(context)
    expect(writes()).toEqual([])
  })

  it('does not ask about an agent it may already message, or one it may reach through a global allow', async () => {
    mount()
    for (const targetAgentSlug of ['billing01x', null]) {
      state.policies = [{ operation: 'invoke', targetAgentSlug, decision: 'allow' }]
      await expect(confirm(`ask ${billing}`)).resolves.toBe(context)
      expect(screen.queryByTestId('mention-access-dialog')).toBeNull()
    }
  })

  it('asks nothing about agents for a message that runs no turn', async () => {
    mount()
    await expect(confirm(`${mike} see what ${billing} said`, true)).resolves.toBe(context)
    expect(state.requests.some((request) => request.url.includes('x-agent-policies'))).toBe(false)
  })

  it('asks nothing of someone who cannot manage the agent', async () => {
    state.canAdmin = false
    mount()
    await expect(confirm(`${sara} ask ${billing}`)).resolves.toBe(context)
    await waitFor(() => expect(state.requests).toEqual([]))
  })
})
