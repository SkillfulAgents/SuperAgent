// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionContextMenu } from './session-context-menu'

const mockApiFetch = vi.fn()

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
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

vi.mock('@renderer/hooks/use-sessions', () => ({
  useDeleteSession: () => ({ mutateAsync: vi.fn() }),
  useUpdateSessionName: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canAdminAgent: () => true }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({}),
  }
})

describe('SessionContextMenu usage totals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
