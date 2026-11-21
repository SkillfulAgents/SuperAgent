// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentCallTab } from '@renderer/context/workflow-context'
import { AgentSessionsTrayContent } from './agent-sessions-tray-content'

const transcript = { messages: [] as unknown[] }
vi.mock('@renderer/hooks/use-messages', () => ({ useMessages: () => ({ data: transcript.messages }) }))
vi.mock('@renderer/hooks/use-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/hooks/use-agents')>()),
  useAgents: () => ({ data: [{ slug: '83tkvj492h', displaySlug: 'business-bot-83tkvj492h', name: 'Business Bot' }] }),
}))
const active = new Set<string>()
vi.mock('@renderer/hooks/query-options', () => ({
  sessionQuery: (slug: string, id: string) => ({ queryKey: ['session', id, slug], queryFn: async () => ({ id, isActive: active.has(id) }) }),
}))
vi.mock('@renderer/components/messages/message-list', () => ({
  MessageList: ({ sessionId }: { sessionId: string }) => <div data-testid="called-transcript">{sessionId}</div>,
}))
vi.mock('@renderer/components/ui/app-link', () => ({ AppLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
const tab = { open: true, viewing: null as AgentCallTab | null }
const viewAgentCall = vi.fn()
vi.mock('@renderer/context/workflow-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/context/workflow-context')>()),
  useWorkflow: () => ({ agentSessions: tab, viewAgentCall }),
}))

const invoke = (id: string, slug: string, prompt: string, sessionId: string) => ({
  id, name: 'mcp__agents__invoke_agent', input: { slug, prompt }, result: `session_id: ${sessionId}\nstatus: running`,
})

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><AgentSessionsTrayContent agentSlug="me" sessionId="s0" /></QueryClientProvider>)
}

describe('AgentSessionsTrayContent', () => {
  beforeEach(() => {
    transcript.messages = [{
      type: 'assistant', id: 'm1', toolCalls: [
        invoke('t1', 'business-bot-83tkvj492h', 'Critique the plan', 's1'),
        invoke('t2', 'writer', 'Draft the post', 's2'),
      ],
    }]
    active.clear()
    tab.viewing = null
    viewAgentCall.mockClear()
  })

  it('lists the called sessions, working ones first, and picks one by the agent\'s id', async () => {
    active.add('s1')
    const user = userEvent.setup()
    renderTab()
    await waitFor(() => expect(screen.getByTestId('agent-sessions-active')).toBeInTheDocument())
    const working = within(screen.getByTestId('agent-sessions-active')).getAllByTestId('agent-sessions-list-row')
    expect(working.map(row => row.textContent)).toEqual(['Business BotCritique the plan'])
    expect(within(screen.getByTestId('agent-sessions-done')).getByTestId('agent-sessions-list-row')).toHaveTextContent('writerDraft the post')
    await user.click(working[0])
    expect(viewAgentCall).toHaveBeenCalledWith({ slug: '83tkvj492h', sessionId: 's1' })
  })

  it('shows a picked conversation in place, with a way back to the list', async () => {
    tab.viewing = { slug: '83tkvj492h', sessionId: 's1' }
    const user = userEvent.setup()
    renderTab()
    expect(screen.getByTestId('called-transcript')).toHaveTextContent('s1')
    expect(screen.getByTestId('agent-call-tray')).toHaveTextContent('Business Bot')
    await user.click(screen.getByTestId('agent-call-back'))
    expect(viewAgentCall).toHaveBeenCalledWith(null)
  })
})
