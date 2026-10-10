// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionContextMenu } from './session-context-menu'

const IDLE = { isActive: false, isAwaitingInput: false }

const mockApiFetch = vi.fn()
const mockDownloadBlob = vi.fn()
const mockToastError = vi.fn()
const mockPreventDefault = vi.fn()
const mockWriteText = vi.fn().mockResolvedValue(undefined)
const {
  mockFork,
  mockForkAndCompact,
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
    mockForkAndCompact: vi.fn(),
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

vi.mock('@renderer/lib/download', () => ({
  downloadBlob: (...args: unknown[]) => mockDownloadBlob(...args),
}))

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
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
    onSelect,
    disabled,
    'data-testid': testId,
    ...props
  }: {
    children: React.ReactNode
    onClick?: () => void
    onSelect?: (event: { preventDefault: () => void }) => void
    disabled?: boolean
    'data-testid'?: string
  }) => (
    <button
      type="button"
      data-testid={testId}
      data-disabled={disabled ? '' : undefined}
      disabled={disabled}
      onClick={disabled ? undefined : () => {
        onSelect?.({ preventDefault: mockPreventDefault })
        onClick?.()
      }}
      {...props}
    >
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSubTrigger: ({
    children,
    disabled,
    'data-testid': testId,
  }: {
    children: React.ReactNode
    disabled?: boolean
    'data-testid'?: string
  }) => (
    <div data-testid={testId} data-disabled={disabled ? '' : undefined}>
      {children}
    </div>
  ),
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

vi.mock('@renderer/components/todo/todo-add-session-item', () => ({
  AddSessionToTodoItem: () => null,
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useDeleteSession: () => ({ mutateAsync: vi.fn() }),
  useUpdateSessionName: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetSessionMarkedUnread: () => ({ mutateAsync: mockSetMarkedUnread, isPending: false }),
  useForkSession: () => ({ mutateAsync: mockFork }),
  useForkAndCompact: () => ({ mutateAsync: mockForkAndCompact }),
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
  }
})
// Off the session route, as when the menu is opened from a list row.
vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({ selectedAgentSlug: 'agent-1', view: { kind: 'home' } }),
}))

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
      <SessionContextMenu sessionId="session-1" sessionName="Session One" agentSlug="agent-1" activity={IDLE}>
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
      <SessionContextMenu sessionId="session-2" sessionName="Missing Price" agentSlug="agent-1" activity={IDLE}>
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
      <SessionContextMenu sessionId="session-3" sessionName="Incomplete" agentSlug="agent-1" activity={IDLE}>
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
      <SessionContextMenu sessionId="session-4" sessionName="Tiny Cost" agentSlug="agent-1" activity={IDLE}>
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
      <SessionContextMenu sessionId="session-9" sessionName="Session Nine" agentSlug="agent-2" activity={IDLE}>
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
      <SessionContextMenu sessionId="session-9" sessionName="Session Nine" agentSlug="agent-2" activity={IDLE}>
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
      <SessionContextMenu sessionId="session-9" sessionName="Session Nine" agentSlug="agent-2" activity={IDLE}>
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
        activity={{ ...IDLE, isActive: true }}
      >
        <button type="button">Session Nine</button>
      </SessionContextMenu>,
    )

    expect(screen.queryByTestId('mark-unread-session-item')).not.toBeInTheDocument()
  })

  it('hides the item while the session is awaiting input', () => {
    render(
      <SessionContextMenu
        sessionId="session-9"
        sessionName="Session Nine"
        agentSlug="agent-2"
        activity={{ ...IDLE, isAwaitingInput: true }}
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
    mockForkAndCompact.mockReset()
    mockSnapshot.mockClear()
    mockSeed.mockReset()
    mockSetQueryData.mockReset()
    mockNavigate.mockReset()
    mockPreventDefault.mockClear()
    mockCanUse.value = true
    mockFork.mockResolvedValue(undefined)
    mockForkAndCompact.mockResolvedValue(undefined)
    mockCanAdminAgent.mockReturnValue(true)
    mockCanUseAgent.mockReturnValue(true)
  })

  function renderMenu(activity: Partial<typeof IDLE> = {}) {
    return render(
      <SessionContextMenu sessionId="src-1" sessionName="Pricing" agentSlug="agent-a" activity={{ ...IDLE, ...activity }}>
        <div>row</div>
      </SessionContextMenu>,
    )
  }

  it('shows the submenu, with both entries, for anyone who can use the agent', () => {
    renderMenu()
    expect(screen.getByTestId('fork-session-trigger')).toHaveTextContent('Fork Session')
    expect(screen.getByTestId('fork-session-item')).toHaveTextContent('Fork')
    expect(screen.getByTestId('fork-summarize-session-item')).toHaveTextContent('Fork & Summarize')
  })

  it('hides the submenu without canUseAgent', () => {
    mockCanUse.value = false
    renderMenu()
    expect(screen.queryByTestId('fork-session-trigger')).toBeNull()
  })

  it('keeps the menu open and spins the clicked row until the copy opens', async () => {
    let openCopy!: () => void
    mockFork.mockReturnValue(new Promise<void>((resolve) => { openCopy = resolve }))
    renderMenu()
    const trigger = screen.getByText('row')
    const item = screen.getByTestId('fork-session-item')
    fireEvent.click(item)
    expect(mockPreventDefault).toHaveBeenCalled()
    expect(within(item).queryByRole('img', { name: 'in progress' })).not.toBeNull()
    expect(within(screen.getByTestId('fork-summarize-session-item')).queryByRole('img', { name: 'in progress' })).toBeNull()
    openCopy()
    // The menu remounts closed once the copy opens.
    await waitFor(() => expect(screen.getByText('row')).not.toBe(trigger))
    expect(within(screen.getByTestId('fork-session-item')).queryByRole('img', { name: 'in progress' })).toBeNull()
    expect(within(screen.getByTestId('fork-session-item')).queryByRole('img', { name: 'done' })).toBeNull()
  })

  it('keeps the submenu and both rows enabled while the source is running', () => {
    renderMenu({ isActive: true })
    expect(screen.getByTestId('fork-session-trigger')).not.toHaveAttribute('data-disabled')
    expect(screen.getByTestId('fork-session-item')).not.toHaveAttribute('data-disabled')
    expect(screen.getByTestId('fork-summarize-session-item')).not.toHaveAttribute('data-disabled')
  })

  it.each([
    ['fork-session-item', mockFork],
    ['fork-summarize-session-item', mockForkAndCompact],
  ])('closes the menu when %s fails', async (testId, mock) => {
    mock.mockRejectedValue(new Error('Failed to fork session'))
    renderMenu()
    const trigger = screen.getByText('row')
    fireEvent.click(screen.getByTestId(testId))
    await waitFor(() => expect(screen.getByText('row')).not.toBe(trigger))
    expect(within(screen.getByTestId(testId)).queryByRole('img', { name: 'in progress' })).toBeNull()
  })

  it('forks; navigation, draft and cache seed live in the hook', async () => {
    renderMenu()
    fireEvent.click(screen.getByTestId('fork-session-item'))
    await waitFor(() => expect(mockFork).toHaveBeenCalledWith({ sessionId: 'src-1', agentSlug: 'agent-a' }))
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(mockSnapshot).not.toHaveBeenCalled()
    expect(mockSeed).not.toHaveBeenCalled()
    expect(mockSetQueryData).not.toHaveBeenCalled()
  })

  it('forks and summarizes through the shared chain', async () => {
    renderMenu()
    fireEvent.click(screen.getByTestId('fork-summarize-session-item'))
    await waitFor(() => expect(mockForkAndCompact).toHaveBeenCalledWith({ sessionId: 'src-1', agentSlug: 'agent-a' }))
    expect(mockFork).not.toHaveBeenCalled()
  })

})

describe('SessionContextMenu raw log', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCanUse.value = true
    mockCanAdminAgent.mockReturnValue(true)
    mockCanUseAgent.mockReturnValue(true)
    mockDownloadBlob.mockResolvedValue(undefined)
    mockWriteText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mockWriteText },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function renderMenu() {
    return render(
      <SessionContextMenu sessionId="session-1" sessionName="Code PR Review" agentSlug="agent-1" activity={IDLE}>
        <button type="button">Code PR Review</button>
      </SessionContextMenu>,
    )
  }

  it('copies with the menu open: spinner, then a check for 2s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockApiFetch.mockResolvedValue({ ok: true, text: async () => 'log-line\n' })
    renderMenu()
    const item = screen.getByTestId('copy-session-raw-log-item')

    fireEvent.click(item)
    expect(mockPreventDefault).toHaveBeenCalled()
    expect(within(item).queryByRole('img', { name: 'in progress' })).not.toBeNull()

    await waitFor(() => expect(within(item).queryByRole('img', { name: 'done' })).not.toBeNull())
    expect(mockWriteText).toHaveBeenCalledWith('log-line\n')
    expect(within(item).queryByRole('img', { name: 'in progress' })).toBeNull()

    act(() => { vi.advanceTimersByTime(2000) })
    expect(within(item).queryByRole('img', { name: 'done' })).toBeNull()
    expect(item.querySelector('.lucide-clipboard-copy')).not.toBeNull()
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('ignores a second click while the copy is still running', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, text: async () => 'log-line\n' })
    renderMenu()
    const item = screen.getByTestId('copy-session-raw-log-item')

    fireEvent.click(item)
    fireEvent.click(item)

    await waitFor(() => expect(within(item).queryByRole('img', { name: 'done' })).not.toBeNull())
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
  })

  it('toasts when copy fails, and shows no check', async () => {
    mockApiFetch.mockResolvedValue({ ok: false })
    renderMenu()
    const item = screen.getByTestId('copy-session-raw-log-item')

    fireEvent.click(item)

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Could not copy raw log', {
        description: 'Failed to fetch raw log',
      })
    })
    await waitFor(() => expect(within(item).queryByRole('img', { name: 'in progress' })).toBeNull())
    expect(within(item).queryByRole('img', { name: 'done' })).toBeNull()
    expect(mockWriteText).not.toHaveBeenCalled()
  })

  it('downloads the session transcript as a jsonl file, then shows a check', async () => {
    const response = { ok: true, text: async () => 'log-line\n' }
    mockApiFetch.mockResolvedValue(response)
    renderMenu()
    const item = screen.getByTestId('download-session-raw-log-item')

    fireEvent.click(item)

    await waitFor(() => expect(within(item).queryByRole('img', { name: 'done' })).not.toBeNull())
    expect(mockDownloadBlob).toHaveBeenCalledWith(response, 'Code-PR-Review.jsonl')
  })

  it('toasts when download fails, and shows no check', async () => {
    mockApiFetch.mockResolvedValue({ ok: false })
    renderMenu()
    const item = screen.getByTestId('download-session-raw-log-item')

    fireEvent.click(item)

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Could not download raw log', {
        description: 'Failed to fetch raw log',
      })
    })
    await waitFor(() => expect(within(item).queryByRole('img', { name: 'in progress' })).toBeNull())
    expect(within(item).queryByRole('img', { name: 'done' })).toBeNull()
    expect(mockDownloadBlob).not.toHaveBeenCalled()
  })
})
