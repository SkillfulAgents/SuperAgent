// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mockApiFetch }))

vi.mock('@renderer/hooks/use-agents', () => ({
  useDeleteAgent: () => ({ mutateAsync: vi.fn() }),
  useUpdateAgent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRouteAgentId: () => undefined,
}))
// The settings dialog pulls in its own data stack; this test is about one menu
// item, so stub it out.
vi.mock('./agent-settings-dialog', () => ({ AgentSettingsDialog: () => null }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canAdminAgent: () => true, isAuthMode: false }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Radix context menus never open in jsdom without a real pointer; render the
// items inline so the action is reachable.
vi.mock('@renderer/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>{children}</button>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'
import { AgentContextMenu } from './agent-context-menu'

/**
 * `open: true` makes the API run the file manager on ITS OWN host. Right when
 * the API is this computer; against a cloud workspace it asks the deployment to
 * launch `open`/`explorer`/`xdg-open` where nobody is looking.
 */

const AGENT = { slug: 'sales', name: 'Sales', status: 'running' } as never

function drive(target: 'local' | 'cloud') {
  _resetApiTargetForTest() // the global setup already settled it to 'local'
  setActiveTarget(target, null)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ path: '/srv/agents/sales' }) })
  window.electronAPI = { platform: 'darwin' } as never
  drive('local')
})

afterEach(() => {
  cleanup()
  delete (window as { electronAPI?: unknown }).electronAPI
  _resetApiTargetForTest()
})

describe('the agent directory action', () => {
  it('asks this computer to open the folder when it runs the agent', async () => {
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    expect(screen.getByText('Show Agent Directory')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('open-agent-directory-item'))

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/sales/open-directory',
        expect.objectContaining({ body: JSON.stringify({ open: true }) }),
      ),
    )
  })

  it('never asks a cloud workspace to launch a file manager on its own host', async () => {
    drive('cloud')
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    await userEvent.click(screen.getByTestId('open-agent-directory-item'))

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/sales/open-directory',
        expect.objectContaining({ body: JSON.stringify({ open: false }) }),
      ),
    )
  })

  it('offers the copy-the-path action remotely, which is the part that works', async () => {
    drive('cloud')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    expect(screen.getByText('Copy Agent Directory Path')).toBeInTheDocument()
    expect(screen.queryByText('Show Agent Directory')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('open-agent-directory-item'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/srv/agents/sales'))
  })
})
