// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConversationHistorySection } from './conversation-history-section'
import { makeSession, makeAccess } from './test-factories'
import type { ChatIntegration, ChatIntegrationSession, ChatIntegrationAccess } from '@shared/lib/db/schema'

vi.mock('@renderer/components/messages/session-thread', () => ({
  SessionThread: (p: any) => <div data-testid="session-thread">{p.sessionId}</div>,
}))
vi.mock('@renderer/context/file-preview-context', () => ({
  FilePreviewProvider: ({ children }: any) => <>{children}</>,
}))

// The inbox + rows pull react-query hooks; stub the whole module so the test
// stays a pure render of the inbox logic. "New conversation" (clear) now lives
// in ChatIntegrationView's title bar - see chat-integration-view.test.tsx.
const h = vi.hoisted(() => ({
  access: [] as ChatIntegrationAccess[],
  approve: vi.fn(),
  deny: vi.fn(),
  revoke: vi.fn(),
}))
vi.mock('@renderer/hooks/use-chat-integrations', () => ({
  useChatIntegrationAccess: () => ({ data: h.access }),
  useSetRequireApproval: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useApproveChatAccess: () => ({ mutate: h.approve, isPending: false }),
  useDenyChatAccess: () => ({ mutate: h.deny, isPending: false }),
  useRevokeChatAccess: () => ({ mutate: h.revoke, isPending: false }),
}))

function s(id: string, ms: number, archived = false, name?: string): ChatIntegrationSession {
  return makeSession({
    id, externalChatId: `chat-${id}`, sessionId: `sess-${id}`,
    displayName: name ?? null, archivedAt: archived ? new Date(ms) : null,
    createdAt: new Date(ms), updatedAt: new Date(ms),
  })
}
const integration = { id: 'int-1', provider: 'telegram', agentSlug: 'a', requireApproval: true } as ChatIntegration
const base = {
  integration, routeNewChatId: null, onSelectWindow: vi.fn(), onNewConversation: vi.fn(),
  agentSlug: 'a', providerName: 'Telegram', canManageAccess: true,
}

beforeEach(() => {
  h.access = []
  h.approve.mockReset()
  h.deny.mockReset()
  h.revoke.mockReset()
  base.onSelectWindow = vi.fn()
  base.onNewConversation = vi.fn()
})

describe('ConversationHistorySection (inbox)', () => {
  it('shows the conversation list by default, without auto-opening a thread', () => {
    render(<ConversationHistorySection {...base} sessions={[s('a', 3000, false, 'Live one')]} routeSessionId={null} />)
    expect(screen.getByText('Conversations')).toBeInTheDocument()
    expect(screen.getByText('Live one')).toBeInTheDocument()
    expect(screen.queryByTestId('session-thread')).not.toBeInTheDocument()
  })

  it('opens a conversation in a dialog when ?session is set and closing backs out to the list', () => {
    const onSelectWindow = vi.fn()
    render(<ConversationHistorySection {...base} onSelectWindow={onSelectWindow} sessions={[s('a', 3000, false, 'Live one')]} routeSessionId="sess-a" />)
    expect(screen.getByTestId('session-thread')).toHaveTextContent('sess-a')
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onSelectWindow).toHaveBeenCalledWith(null)
  })

  it('shows a pending chat tagged Blocked with Approve/Deny actions for a Telegram owner', () => {
    h.access = [makeAccess({ externalChatId: 'chat-p', status: 'pending', title: 'Dana', firstMessagePreview: 'hello?' })]
    render(<ConversationHistorySection {...base} sessions={[]} routeSessionId={null} />)
    expect(screen.getByText('Dana')).toBeInTheDocument()
    expect(screen.getByText('Blocked')).toBeInTheDocument()
    // A pending request offers both decisions directly - not a single "Unblock".
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Block' })).not.toBeInTheDocument()
  })

  it('shows a denied chat with an Unblock action', () => {
    h.access = [makeAccess({ externalChatId: 'chat-d', status: 'denied', title: 'Blocked Bob' })]
    render(<ConversationHistorySection {...base} sessions={[]} routeSessionId={null} />)
    expect(screen.getByText('Blocked Bob')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unblock' })).toBeInTheDocument()
  })

  it('clicking Approve on a pending chat approves it with its integration + access ids', () => {
    // makeAccess sets id: `acc-<externalChatId>`, so this row's accessId is 'acc-chat-p'.
    h.access = [makeAccess({ externalChatId: 'chat-p', status: 'pending', title: 'Dana' })]
    render(<ConversationHistorySection {...base} sessions={[]} routeSessionId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(h.approve).toHaveBeenCalledTimes(1)
    expect(h.approve).toHaveBeenCalledWith(
      { integrationId: 'int-1', accessId: 'acc-chat-p' },
      expect.objectContaining({ onSuccess: undefined }),
    )
    expect(h.revoke).not.toHaveBeenCalled()
  })

  it('clicking Deny on a pending chat denies it', () => {
    h.access = [makeAccess({ externalChatId: 'chat-p', status: 'pending', title: 'Dana' })]
    render(<ConversationHistorySection {...base} sessions={[]} routeSessionId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(h.deny).toHaveBeenCalledWith(
      { integrationId: 'int-1', accessId: 'acc-chat-p' },
      expect.objectContaining({ onSuccess: undefined }),
    )
    expect(h.approve).not.toHaveBeenCalled()
  })

  it('shows Block (not Unblock) on an allowed chat and revoking it uses the right ids', () => {
    h.access = [makeAccess({ externalChatId: 'chat-x', status: 'allowed', title: 'Allowed Al' })]
    render(<ConversationHistorySection {...base} sessions={[]} routeSessionId={null} />)
    expect(screen.getByRole('button', { name: 'Block' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unblock' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Block' }))
    expect(h.revoke).toHaveBeenCalledTimes(1)
    expect(h.revoke).toHaveBeenCalledWith(
      { integrationId: 'int-1', accessId: 'acc-chat-x' },
      expect.objectContaining({ onSuccess: undefined }),
    )
    expect(h.approve).not.toHaveBeenCalled()
  })

  it('tags a chat allowed by first contact as "Auto-allowed"', () => {
    h.access = [makeAccess({ externalChatId: 'chat-a', status: 'allowed', title: 'Auto Amy', approvalSource: 'auto_first_contact' })]
    render(<ConversationHistorySection {...base} sessions={[]} routeSessionId={null} />)
    expect(screen.getByText('Auto-allowed')).toBeInTheDocument()
  })

  it('renders the empty state when there are no chats', () => {
    render(<ConversationHistorySection {...base} sessions={[]} routeSessionId={null} />)
    expect(screen.getByText(/no conversations yet\. send a message from telegram to start\./i)).toBeInTheDocument()
    expect(screen.queryByTestId('session-thread')).not.toBeInTheDocument()
  })


  it('renders a blank new-conversation view in the dialog when routeNewChatId is set', () => {
    render(<ConversationHistorySection {...base} sessions={[s('a', 3000, true, 'Cleared one')]} routeSessionId={null} routeNewChatId="chat-a" />)
    expect(screen.getByText(/no messages yet\./i)).toBeInTheDocument()
    expect(screen.queryByTestId('session-thread')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument()
  })
})
