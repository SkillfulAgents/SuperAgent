// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  createSession: vi.fn(),
  agents: [] as Array<{ slug: string; name: string }>,
  assigned: [] as string[],
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: async () => Response.json({ rules: [] }) }))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgents: () => ({ data: mocks.agents, isLoading: false }) }))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({
  useAccountAgents: () => ({ data: { agentSlugs: mocks.assigned }, isLoading: false }),
}))
vi.mock('@renderer/hooks/use-remote-mcps', () => ({
  useMcpAgents: () => ({ data: { agentSlugs: mocks.assigned }, isLoading: false }),
}))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: false, rolesReady: true, canUseAgent: () => true }),
}))
vi.mock('@renderer/hooks/use-sessions', () => ({
  useCreateSession: () => ({ mutate: mocks.createSession, isPending: false }),
}))
// The real picker is a searchable popover; a plain select stands in for it.
vi.mock('@renderer/components/agents/agent-dropdown', () => ({
  AgentDropdown: ({ value, onValueChange, filter }: {
    value: string | null
    onValueChange: (slug: string) => void
    filter: (agent: { slug: string }) => boolean
  }) => (
    <select aria-label="Agent" value={value ?? ''} onChange={(e) => onValueChange(e.target.value)}>
      <option value="">Choose an agent</option>
      {mocks.agents.filter(filter).map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
    </select>
  ),
}))

import { ProxyRulesSection, ruleRequestPrompt } from './proxy-rules-section'

function renderSection(props: { agentSlug?: string } = {}) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProxyRulesSection kind="api" targetId="acct-1" targetName="me@acme.com" {...props} />
    </QueryClientProvider>,
  )
}

async function describeRule(text: string) {
  await userEvent.click(await screen.findByRole('button', { name: 'Add rule' }))
  await userEvent.type(screen.getByTestId('proxy-rule-description'), text)
}

describe('ProxyRulesSection', () => {
  beforeEach(() => {
    mocks.navigate.mockReset()
    mocks.createSession.mockReset()
    mocks.agents = [{ slug: 'mail', name: 'Mail' }, { slug: 'ops', name: 'Ops' }, { slug: 'other', name: 'Other' }]
    mocks.assigned = ['mail', 'ops']
  })

  it('asks the only agent with the connection for a rule on every agent, and opens that chat', async () => {
    mocks.assigned = ['mail']
    mocks.createSession.mockImplementation((_vars, options: { onSuccess: (s: { id: string }) => void }) => options.onSuccess({ id: 'sess-1' }))
    renderSection()
    await describeRule('Let it send to @acme.com only')
    await userEvent.click(screen.getByTestId('proxy-rule-create'))

    expect(mocks.createSession).toHaveBeenCalledWith(
      {
        agentSlug: 'mail',
        message: ruleRequestPrompt({ kind: 'api', targetId: 'acct-1', targetName: 'me@acme.com', description: 'Let it send to @acme.com only', appliesTo: 'all_agents' }),
      },
      expect.anything(),
    )
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/agents/$slug/sessions/$sessionId', params: { slug: 'mail', sessionId: 'sess-1' } })
  })

  it('picks the agent whose connections it was opened from, for that agent only', async () => {
    renderSection({ agentSlug: 'ops' })
    await describeRule('Let it send to @acme.com only')
    await userEvent.click(screen.getByTestId('proxy-rule-create'))

    const [vars] = mocks.createSession.mock.calls[0] as [{ agentSlug: string; message: string }]
    expect(vars.agentSlug).toBe('ops')
    expect(vars.message).toContain('apply to only your requests')
  })

  it('waits for a choice when several agents have the connection, offering only those', async () => {
    renderSection()
    await describeRule('Let it send to @acme.com only')
    expect(screen.getByTestId('proxy-rule-create')).toBeDisabled()
    expect(screen.queryByRole('option', { name: 'Other' })).toBeNull()

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Agent' }), 'mail')
    await userEvent.click(screen.getByTestId('proxy-rule-create'))
    expect(mocks.createSession.mock.calls[0][0]).toMatchObject({ agentSlug: 'mail' })
  })

  it('explains that an agent needs the connection when none has it', async () => {
    mocks.assigned = []
    renderSection({ agentSlug: 'other' })
    await describeRule('Let it send to @acme.com only')
    expect(screen.getByTestId('proxy-rule-no-agent')).toBeInTheDocument()
    expect(screen.getByTestId('proxy-rule-create')).toBeDisabled()
  })
})

describe('ruleRequestPrompt', () => {
  it('names the connection and quotes every line of the request', () => {
    const prompt = ruleRequestPrompt({ kind: 'mcp', targetId: 'mcp-1', targetName: 'Payments', description: 'Up to $5,000\nOnly in USD', appliesTo: 'all_agents' })
    expect(prompt).toContain('the MCP server "Payments" (MCP id mcp-1)')
    expect(prompt).toContain('> Up to $5,000\n> Only in USD')
    expect(prompt).toContain('apply to every agent using this connection')
  })
})
