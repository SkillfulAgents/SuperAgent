// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ChatIntegrationView } from './chat-integration-view'

const DEFAULT_SESSIONS = [
  { id: 's1', sessionId: 'sess-1', externalChatId: 'chat-1', archivedAt: null, updatedAt: new Date(2000) },
  { id: 's2', sessionId: 'sess-2', externalChatId: 'chat-2', archivedAt: null, updatedAt: new Date(5000) },
]
// Mutable session list - reassign per-test to override the default fixture.
let sessionsMock: any[] = DEFAULT_SESSIONS

// Mutable user capabilities - set per-test to simulate viewer vs manager roles.
const userState = vi.hoisted(() => ({ canUseAgent: true, canAdminAgent: true }))

// The inbox owns list/dialog selection; the view just wires props. Mirror the
// route session id and expose the navigation callbacks the view passes down.
vi.mock('./conversation-history-section', () => ({
  ConversationHistorySection: (p: any) => (
    <div data-testid="inbox">
      route:{p.routeSessionId ?? 'none'}
      <button onClick={() => p.onSelectWindow('sess-x')}>open</button>
      <button onClick={() => p.onSelectWindow(null)}>back</button>
    </div>
  ),
}))
vi.mock('./chat-integration-side-panel', () => ({
  ChatIntegrationSidePanel: () => <div data-testid="panel" />,
}))
vi.mock('./integration-delete-button', () => ({
  IntegrationDeleteButton: (p: any) => <button onClick={p.onDeleted}>delete</button>,
}))

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    canUseAgent: () => userState.canUseAgent,
    canAdminAgent: () => userState.canAdminAgent,
  }),
}))
const integrationMock = vi.hoisted(() => ({
  current: { id: 'int-1', agentSlug: 'a', provider: 'telegram', name: 'Bot', status: 'active', errorMessage: null },
}))
const clearAsync = vi.fn<(args: unknown) => Promise<unknown>>().mockResolvedValue(undefined)
const updateAsync = vi.fn<(args: unknown) => Promise<unknown>>().mockResolvedValue({})
vi.mock('@renderer/hooks/use-chat-integrations', () => ({
  useChatIntegration: () => ({ data: integrationMock.current, isLoading: false, error: null }),
  useChatIntegrationStatus: () => ({ data: { connected: true } }),
  useChatIntegrationSessions: () => ({ data: sessionsMock }),
  useClearChatSession: () => ({ mutateAsync: clearAsync, isPending: false }),
  useUpdateChatIntegration: () => ({ mutateAsync: updateAsync, isPending: false }),
}))
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgent: () => ({ data: { slug: 'a', name: 'Story Spinner' } }),
  useAgents: () => ({ data: [{ id: 'a', slug: 'a', name: 'Story Spinner' }] }),
  // Identity resolve: keeps the canonicalize guard equivalent to a raw
  // `integration.agentSlug !== agentSlug`, matching these tests' assumptions.
  resolveRouteAgentId: (slug: string) => slug,
}))

afterEach(() => {
  sessionsMock = DEFAULT_SESSIONS
  userState.canUseAgent = true
  userState.canAdminAgent = true
  integrationMock.current = { id: 'int-1', agentSlug: 'a', provider: 'telegram', name: 'Bot', status: 'active', errorMessage: null }
  navigate.mockReset()
  clearAsync.mockReset()
  clearAsync.mockResolvedValue(undefined)
  updateAsync.mockReset()
  updateAsync.mockResolvedValue({})
})

async function confirmNewConversation() {
  const { default: userEvent } = await import('@testing-library/user-event')
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /new conversation/i }))
  const dialog = await screen.findByRole('alertdialog')
  await user.click(within(dialog).getByRole('button', { name: 'New conversation' }))
  return user
}

describe('ChatIntegrationView', () => {
  it('renders the integration name (when set) and provider tag', () => {
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    expect(screen.getByText('Bot')).toBeInTheDocument()
    expect(screen.getByText('Telegram')).toBeInTheDocument()
    expect(screen.getByText('Remote Chat')).toBeInTheDocument()
  })

  it('falls back to the agent name when the integration has no custom name (matches the agent-home row list)', () => {
    integrationMock.current = { ...integrationMock.current, name: '' }
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    expect(screen.getByText('Story Spinner')).toBeInTheDocument()
  })

  it('renames the integration when the owner edits the title inline', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    await user.click(screen.getByTestId('integration-name'))
    const input = screen.getByTestId('integration-name-input')
    await user.clear(input)
    await user.type(input, 'Support Bot{Enter}')
    expect(updateAsync).toHaveBeenCalledWith({ id: 'int-1', name: 'Support Bot' })
  })

  it('shows the title read-only for a viewer (no rename affordance)', () => {
    userState.canUseAgent = false
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    expect(screen.getByText('Bot')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rename integration' })).toBeNull()
  })

  it('passes the route ?session through to the inbox', () => {
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId="sess-1" chatNewConvId={null} />)
    expect(screen.getByTestId('inbox')).toHaveTextContent('route:sess-1')
  })

  it('passes null through when there is no ?session', () => {
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    expect(screen.getByTestId('inbox')).toHaveTextContent('route:none')
  })

  it('navigates with ?session when the inbox opens a window', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    await user.click(screen.getByText('open'))
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { session: 'sess-x' } }))
  })

  it('clears ?session when the inbox goes back to the list', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId="sess-1" chatNewConvId={null} />)
    await user.click(screen.getByText('back'))
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: {} }))
  })

  it('deletes and navigates home', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    await user.click(screen.getByText('delete'))
    expect(navigate).toHaveBeenCalledWith({ to: '/agents/$slug', params: { slug: 'a' } })
  })

  it('shows New conversation next to Delete whenever a live conversation exists', () => {
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    expect(screen.getByRole('button', { name: /new conversation/i })).toBeInTheDocument()
    expect(screen.getByText('delete')).toBeInTheDocument()
  })

  it('hides New conversation when every conversation is archived', () => {
    sessionsMock = DEFAULT_SESSIONS.map((s) => ({ ...s, archivedAt: new Date(9000) }))
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    expect(screen.queryByRole('button', { name: /new conversation/i })).not.toBeInTheDocument()
  })

  it('hides New conversation for viewers', () => {
    userState.canUseAgent = false
    userState.canAdminAgent = false
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    expect(screen.queryByRole('button', { name: /new conversation/i })).not.toBeInTheDocument()
  })

  it('clears the most recently active conversation from the list view', async () => {
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    await confirmNewConversation()
    // sess-2 (updatedAt 5000) is newer than sess-1 (2000).
    expect(clearAsync).toHaveBeenCalledWith({ integrationId: 'int-1', sessionId: 's2' })
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { newchat: 'chat-2' } }))
  })

  it('targets the open conversation when one is being viewed', async () => {
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId="sess-1" chatNewConvId={null} />)
    await confirmNewConversation()
    expect(clearAsync).toHaveBeenCalledWith({ integrationId: 'int-1', sessionId: 's1' })
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { newchat: 'chat-1' } }))
  })

  it('does not navigate when the open session changed before the clear resolved (race guard)', async () => {
    let resolveClear!: () => void
    clearAsync.mockReturnValueOnce(new Promise((res) => { resolveClear = () => res(undefined) }))
    const { rerender } = render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId="sess-1" chatNewConvId={null} />)
    await confirmNewConversation() // clears sess-1; promise still pending
    // The route changes to the other chat before the clear resolves.
    rerender(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId="sess-2" chatNewConvId={null} />)
    resolveClear()
    await Promise.resolve()
    await Promise.resolve()
    // sess-1 (cleared) !== sess-2 (now open) → guard suppresses the navigate.
    expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ search: { newchat: 'chat-1' } }))
  })

  it('shows an error alert when the clear fails', async () => {
    clearAsync.mockRejectedValueOnce(new Error('boom'))
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId="sess-1" chatNewConvId={null} />)
    await confirmNewConversation()
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('does not render the side panel for viewers', () => {
    userState.canUseAgent = false
    userState.canAdminAgent = false
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('inbox')).toBeInTheDocument()
  })

  it('renders the side panel for managers', () => {
    render(<ChatIntegrationView integrationId="int-1" agentSlug="a" chatSessionId={null} chatNewConvId={null} />)
    expect(screen.getByTestId('panel')).toBeInTheDocument()
  })

  it('redirects to the integration\'s true agent when the slug mismatches', () => {
    integrationMock.current = { ...integrationMock.current, agentSlug: 'real-owner' }
    render(<ChatIntegrationView integrationId="int-1" agentSlug="wrong" chatSessionId={null} chatNewConvId={null} />)
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      params: { slug: 'real-owner', integrationId: 'int-1' },
      replace: true,
    }))
  })
})
