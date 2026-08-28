// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionContextMenu } from './session-context-menu'

const mockApiFetch = vi.fn()
const {
  mockFork,
  mockSnapshot,
  mockSeed,
  mockSetQueryData,
  mockNavigate,
  mockStore,
  mockCanUse,
} = vi.hoisted(() => {
  const mockCanUse = { value: true }
  return {
    mockFork: vi.fn(),
    mockSnapshot: vi.fn(() => ({ text: 'draft', securedSecrets: undefined })),
    mockSeed: vi.fn(),
    mockSetQueryData: vi.fn(),
    mockNavigate: vi.fn(),
    mockStore: { get: vi.fn(), set: vi.fn() },
    mockCanUse,
  }
})

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

// Keep this test focused on the menu's lazy request behavior. The worktree test
// harness can otherwise resolve Radix and React through different real paths
// when node_modules is shared from the primary checkout.
vi.mock('@renderer/components/ui/context-menu', () => ({
  ContextMenu: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode
    onOpenChange?: (open: boolean) => void
  }) => (
    <div>
      <button type="button" onClick={() => onOpenChange?.(true)}>
        Open context menu
      </button>
      {children}
    </div>
  ),
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({
    children,
    onClick,
    disabled,
    'data-testid': testId,
    ...props
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    'data-testid'?: string
  }) => (
    <button
      type="button"
      data-testid={testId}
      data-disabled={disabled ? '' : undefined}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      {...props}
    >
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
}))

vi.mock('@renderer/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <>{children}</> : null,
  AlertDialogAction: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const mockSetMarkedUnread = vi.fn().mockResolvedValue({ success: true })

vi.mock('@renderer/hooks/use-sessions', () => ({
  useDeleteSession: () => ({ mutateAsync: vi.fn() }),
  useUpdateSessionName: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetSessionMarkedUnread: () => ({ mutateAsync: mockSetMarkedUnread, isPending: false }),
  useForkSession: () => ({ mutateAsync: mockFork, isPending: false }),
}))

const mockCanAdminAgent = vi.fn(() => true)
const mockCanUseAgent = vi.fn(() => true)

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    canAdminAgent: mockCanAdminAgent,
    canUseAgent: () => mockCanUse.value && mockCanUseAgent(),
  }),
}))

vi.mock('@renderer/context/drafts-context', () => ({
  useDraftsStore: () => mockStore,
  snapshotSessionDraft: mockSnapshot,
  seedSessionDraft: mockSeed,
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: mockSetQueryData }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({}),
  }
})

describe('SessionContextMenu usage totals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCanUse.value = true
  })

  it('does not calculate usage until the context menu opens', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCost: 0.0042,
        totalTokens: 12_345,
        priceMissing: false,
        usageIncomplete: false,
      }),
    })

    render(
      <SessionContextMenu sessionId="session-1" sessionName="Session One" agentSlug="agent-1">
        <button type="button">Session One</button>
      </SessionContextMenu>,
    )

    expect(mockApiFetch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open context menu' }))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agent-1/sessions/session-1/usage')
    })
    expect(await screen.findByText('$0.0042')).toBeInTheDocument()
    expect(screen.getByText('12,345')).toBeInTheDocument()
  })

  it('shows a missing-price message instead of a misleading zero cost', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCost: 0,
        totalTokens: 79_429,
        priceMissing: true,
        usageIncomplete: false,
      }),
    })

    render(
      <SessionContextMenu sessionId="session-2" sessionName="Missing Price" agentSlug="agent-1">
        <button type="button">Missing Price</button>
      </SessionContextMenu>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open context menu' }))

    expect(await screen.findByText('Model price missing')).toBeInTheDocument()
    expect(screen.getByText('79,429')).toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
  })

  it('warns when transcript errors make the totals potentially incomplete', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCost: 0.12,
        totalTokens: 1_234,
        priceMissing: false,
        usageIncomplete: true,
      }),
    })

    render(
      <SessionContextMenu sessionId="session-3" sessionName="Incomplete" agentSlug="agent-1">
        <button type="button">Incomplete</button>
      </SessionContextMenu>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open context menu' }))

    expect(await screen.findByText('Warning: usage may be incomplete')).toBeInTheDocument()
    expect(screen.getByText('$0.12')).toBeInTheDocument()
    expect(screen.getByText('1,234')).toBeInTheDocument()
  })

  it('does not round a tiny positive cost down to visible zero', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCost: 0.00001,
        totalTokens: 10,
        priceMissing: false,
        usageIncomplete: false,
      }),
    })

    render(
      <SessionContextMenu sessionId="session-4" sessionName="Tiny Cost" agentSlug="agent-1">
        <button type="button">Tiny Cost</button>
      </SessionContextMenu>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open context menu' }))

    expect(await screen.findByText('<$0.0001')).toBeInTheDocument()
    expect(screen.queryByText('$0.0000')).not.toBeInTheDocument()
  })
})

describe('SessionContextMenu mark as unread', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCanUse.value = true
    mockSetMarkedUnread.mockResolvedValue({ success: true })
    mockCanAdminAgent.mockReturnValue(true)
    mockCanUseAgent.mockReturnValue(true)
  })

  it('raises the unread flag for the session it was opened on', async () => {
    render(
      <SessionContextMenu sessionId="session-9" sessionName="Session Nine" agentSlug="agent-2">
        <button type="button">Session Nine</button>
      </SessionContextMenu>,
    )

    fireEvent.click(screen.getByTestId('mark-unread-session-item'))

    await waitFor(() => {
      expect(mockSetMarkedUnread).toHaveBeenCalledWith({
        sessionId: 'session-9',
        agentSlug: 'agent-2',
        markedUnread: true,
      })
    })
  })

  // Unlike rename/delete, marking unread is not permission-gated at all.
  it('stays available to members who cannot admin the agent', () => {
    mockCanAdminAgent.mockReturnValue(false)

    render(
      <SessionContextMenu sessionId="session-9" sessionName="Session Nine" agentSlug="agent-2">
        <button type="button">Session Nine</button>
      </SessionContextMenu>,
    )

    expect(screen.queryByTestId('rename-session-item')).not.toBeInTheDocument()
    expect(screen.getByTestId('mark-unread-session-item')).toBeInTheDocument()
  })

  // A mark is scoped to the acting user, so it raises a dot on their sidebar
  // only — there is no shared state for a permission gate to protect, and
  // gating it would leave a viewer unable to dismiss their own dot.
  it('stays available to a read-only viewer, whose mark only they can see', () => {
    mockCanUseAgent.mockReturnValue(false)

    render(
      <SessionContextMenu sessionId="session-9" sessionName="Session Nine" agentSlug="agent-2">
        <button type="button">Session Nine</button>
      </SessionContextMenu>,
    )

    expect(screen.getByTestId('mark-unread-session-item')).toBeInTheDocument()
  })

  // Every list suppresses the unread dot while a session is working or awaiting
  // input, so offering the item there would be a silent no-op.
  it('hides the item for a live session, where no list would render the dot', () => {
    render(
      <SessionContextMenu
        sessionId="session-9"
        sessionName="Session Nine"
        agentSlug="agent-2"
        sessionIsLive
      >
        <button type="button">Session Nine</button>
      </SessionContextMenu>,
    )

    expect(screen.queryByTestId('mark-unread-session-item')).not.toBeInTheDocument()
  })
})

describe('Fork Session item', () => {
  beforeEach(() => {
    mockFork.mockReset()
    mockSnapshot.mockClear()
    mockSeed.mockReset()
    mockSetQueryData.mockReset()
    mockNavigate.mockReset()
    mockCanUse.value = true
    mockCanAdminAgent.mockReturnValue(true)
    mockCanUseAgent.mockReturnValue(true)
  })

  function renderMenu(props: Partial<{ isActive: boolean }> = {}) {
    return render(
      <SessionContextMenu sessionId="src-1" sessionName="Pricing" agentSlug="agent-a" {...props}>
        <div>row</div>
      </SessionContextMenu>,
    )
  }

  it('shows the item for anyone who can use the agent', () => {
    renderMenu()
    expect(screen.getByTestId('fork-session-item')).toHaveTextContent('Fork Session')
  })

  it('hides the item without canUseAgent', () => {
    mockCanUse.value = false
    renderMenu()
    expect(screen.queryByTestId('fork-session-item')).toBeNull()
  })

  it('disables the item while the source is active', () => {
    renderMenu({ isActive: true })
    expect(screen.getByTestId('fork-session-item')).toHaveAttribute('data-disabled')
  })

  it('snapshots the draft at click time, forks, seeds cache and drafts, and navigates', async () => {
    let resolveFork!: (v: unknown) => void
    mockFork.mockReturnValue(new Promise((r) => { resolveFork = r }))
    renderMenu()
    fireEvent.click(screen.getByTestId('fork-session-item'))
    // Snapshot happened before the network settled.
    expect(mockSnapshot).toHaveBeenCalledWith(mockStore, 'src-1')
    expect(mockSeed).not.toHaveBeenCalled()

    resolveFork({ id: 'fork-1', agentSlug: 'agent-a', name: 'Pricing (fork)' })
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'agent-a', sessionId: 'fork-1' },
    }))
    expect(mockFork).toHaveBeenCalledWith({ sessionId: 'src-1', agentSlug: 'agent-a' })
    expect(mockSetQueryData).toHaveBeenCalledWith(['session', 'fork-1', 'agent-a'], expect.objectContaining({ id: 'fork-1' }))
    expect(mockSeed).toHaveBeenCalledWith(mockStore, 'fork-1', { text: 'draft', securedSecrets: undefined })
  })

  it('stays put and logs when the fork fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockFork.mockRejectedValue(new Error('nope'))
    renderMenu()
    fireEvent.click(screen.getByTestId('fork-session-item'))
    await waitFor(() => expect(err).toHaveBeenCalled())
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(mockSeed).not.toHaveBeenCalled()
    err.mockRestore()
  })
})
