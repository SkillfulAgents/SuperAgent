// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mockApiFetch }))

const { mockUseAgents, mockUpdateAgent } = vi.hoisted(() => ({
  mockUseAgents: vi.fn(),
  mockUpdateAgent: vi.fn(),
}))
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => mockUseAgents(),
  useDeleteAgent: () => ({ mutateAsync: vi.fn() }),
  useUpdateAgent: () => ({ mutateAsync: mockUpdateAgent, isPending: false }),
  useRouteAgentId: () => undefined,
}))
const { mockNavigate, mockSetPendingAgentHomeAction } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockSetPendingAgentHomeAction: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }))
vi.mock('@renderer/context/nav-transient-context', () => ({
  useNavTransient: () => ({ pendingAgentHomeAction: null, setPendingAgentHomeAction: mockSetPendingAgentHomeAction }),
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }))
const { mockUser } = vi.hoisted(() => ({ mockUser: vi.fn() }))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => mockUser(),
}))
// Radix dialogs portal and need pointer plumbing jsdom lacks; render the open
// one inline so the rename form is reachable.
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const { mockUserSettings, mockUpdateSettings } = vi.hoisted(() => ({
  mockUserSettings: vi.fn(),
  mockUpdateSettings: vi.fn(),
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: mockUserSettings() }),
  useUpdateUserSettings: () => ({ mutate: mockUpdateSettings }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Radix context menus never open in jsdom without a real pointer; render the
// items inline so the action is reachable. The content's close hook is kept so
// a test can play the menu finishing its close.
const { menuClose } = vi.hoisted(() => ({
  menuClose: { current: null as null | ((event: { preventDefault: () => void }) => void) },
}))
vi.mock('@renderer/components/ui/context-menu', () => {
  return {
    ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ContextMenuContent: ({ children, onCloseAutoFocus, ...props }: { onCloseAutoFocus?: (event: { preventDefault: () => void }) => void } & React.HTMLAttributes<HTMLDivElement>) => {
      menuClose.current = onCloseAutoFocus ?? null
      return <div {...props}>{children}</div>
    },
    ContextMenuItem: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type="button" onClick={onClick} {...props}>{children}</button>
    ),
    ContextMenuSeparator: () => <hr />,
    ContextMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ContextMenuSubTrigger: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    ContextMenuSubContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  }
})

import { act, render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentContextMenu } from './agent-context-menu'

const AGENT = { slug: 'sales', displaySlug: 'sales-x1', name: 'Sales', status: 'running' } as never
// The canonical filing write rebuilds the whole tree from the agent list, so
// the mock provides the agents the tests file and order-assert against.
const ALL_AGENTS = [
  { slug: 'sales', name: 'Sales', status: 'running' },
  { slug: 'support', name: 'Support', status: 'stopped' },
]

const OWNER = { canAdminAgent: () => true, isAuthMode: false }
const PLAIN_USER = { canAdminAgent: () => false, isAuthMode: true }

function renderMenu(props: Partial<React.ComponentProps<typeof AgentContextMenu>> = {}) {
  return render(
    <AgentContextMenu agent={AGENT} {...props}>
      <span>row</span>
    </AgentContextMenu>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ path: '/srv/agents/sales' }) })
  mockUserSettings.mockReturnValue({ agentFolders: [], agentFolderAssignments: {} })
  mockUseAgents.mockReturnValue({ data: ALL_AGENTS, isLoading: false, error: null })
  mockUpdateAgent.mockResolvedValue(undefined)
  mockUser.mockReturnValue(OWNER)
})

afterEach(() => {
  cleanup()
})

describe('moving an agent into a left-nav folder', () => {
  const FOLDERS = [
    { id: 'f1', name: 'Work' },
    { id: 'f2', name: 'Personal' },
  ]

  // The menu writes settings in the updater form — a function of the latest
  // cached settings, resolved when the (scope-serialized) mutation actually
  // runs — so a filing queued behind an in-flight write cannot revert it.
  // Tests resolve the captured updater against explicit "current" settings.
  const patchWith = (settings: Record<string, unknown>) => {
    const arg = mockUpdateSettings.mock.calls[0][0]
    return typeof arg === 'function' ? arg(settings) : arg
  }

  it('lists every folder the agent is not in, and leaves out "Your Agents" while it is there', () => {
    mockUserSettings.mockReturnValue({ agentFolders: FOLDERS, agentFolderAssignments: {} })
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    // Only destinations are offered, so nothing is marked as current.
    expect(screen.queryByTestId('move-agent-to-no-folder-item')).not.toBeInTheDocument()
    expect(screen.getByTestId('move-agent-to-folder-f1')).toHaveTextContent('Work')
    expect(screen.getByTestId('move-agent-to-folder-f2')).toHaveTextContent('Personal')
    // The destinations are set off from New Folder below them.
    const submenu = screen.getByTestId('move-agent-to-folder-menu')
    expect(within(submenu).getByRole('separator')).toBeInTheDocument()
  })

  it('leaves out the folder the agent is in and offers "Your Agents" instead', () => {
    mockUserSettings.mockReturnValue({
      agentFolders: FOLDERS,
      agentFolderAssignments: { sales: 'f1' },
    })
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    expect(screen.queryByTestId('move-agent-to-folder-f1')).not.toBeInTheDocument()
    expect(screen.getByTestId('move-agent-to-folder-f2')).toHaveTextContent('Personal')
    expect(screen.getByTestId('move-agent-to-no-folder-item')).toHaveTextContent('Your Agents')
  })

  it('files the agent at the end of the folder and keeps agentOrder canonical', async () => {
    // Filing writes the same whole-tree shape a drag writes, so the flat
    // agentOrder the home grid/graph/tray read always matches the sidebar's
    // reading order — an assignment-only write left it stale until the next
    // drag.
    mockUserSettings.mockReturnValue({ agentFolders: FOLDERS, agentFolderAssignments: {} })
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    await userEvent.click(screen.getByTestId('move-agent-to-folder-f1'))

    const patch = patchWith({ agentFolders: FOLDERS, agentFolderAssignments: {} })
    expect(patch.agentFolderAssignments).toEqual({ sales: 'f1' })
    // sales appended to f1, which follows the root block in reading order.
    expect(patch.agentOrder).toEqual(['support', 'sales'])
    expect(patch.agentListOrder).toEqual([
      'agent-folder::root',
      'agent-folder::f1',
      'agent-folder::f2',
    ])
    expect(patch.agentFolders).toEqual(FOLDERS)
  })

  it('preserves other agents\u2019 assignments when filing this one', async () => {
    const settings = { agentFolders: FOLDERS, agentFolderAssignments: { support: 'f2' } }
    mockUserSettings.mockReturnValue(settings)
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    await userEvent.click(screen.getByTestId('move-agent-to-folder-f1'))

    expect(patchWith(settings).agentFolderAssignments).toEqual({
      support: 'f2',
      sales: 'f1',
    })
  })

  it('builds the write from the settings at mutation run time, not click time', async () => {
    // A filing queued while another settings write (say, a drag in the
    // sidebar) is still in flight runs after it settles. The payload must be
    // built from THAT write's result \u2014 a snapshot taken at click time would
    // silently revert it.
    mockUserSettings.mockReturnValue({ agentFolders: FOLDERS, agentFolderAssignments: {} })
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    await userEvent.click(screen.getByTestId('move-agent-to-folder-f1'))

    expect(
      patchWith({ agentFolders: FOLDERS, agentFolderAssignments: { support: 'f2' } })
        .agentFolderAssignments
    ).toEqual({ support: 'f2', sales: 'f1' })
  })

  it('moving to "Your Agents" drops the key rather than storing a folder id', async () => {
    const settings = { agentFolders: FOLDERS, agentFolderAssignments: { sales: 'f1' } }
    mockUserSettings.mockReturnValue(settings)
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    await userEvent.click(screen.getByTestId('move-agent-to-no-folder-item'))

    const patch = patchWith(settings)
    expect(patch.agentFolderAssignments).toEqual({})
    // Un-filing appends to the end of "Your Agents", mirroring how filing
    // appends to a folder.
    expect(patch.agentOrder).toEqual(['support', 'sales'])
  })

  it('reads an assignment naming a deleted folder as the default folder', () => {
    // The sidebar renders such an agent under "Your Agents", so the menu has
    // to agree: that is where it is, so it is not offered as a destination.
    mockUserSettings.mockReturnValue({
      agentFolders: FOLDERS,
      agentFolderAssignments: { sales: 'gone' },
    })
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    expect(screen.queryByTestId('move-agent-to-no-folder-item')).not.toBeInTheDocument()
    expect(screen.getByTestId('move-agent-to-folder-f1')).toBeInTheDocument()
    expect(screen.getByTestId('move-agent-to-folder-f2')).toBeInTheDocument()
  })

  it('creates a named folder and files the agent into it in one write', async () => {
    const settings = { agentFolders: FOLDERS, agentFolderAssignments: {} }
    mockUserSettings.mockReturnValue(settings)
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    await userEvent.click(screen.getByTestId('move-agent-to-new-folder-item'))
    await userEvent.type(screen.getByTestId('new-agent-folder-name-input'), 'Clients')
    await userEvent.click(screen.getByTestId('confirm-new-agent-folder-button'))

    expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    const patch = patchWith(settings)
    expect(patch.agentFolders).toHaveLength(3)
    expect(patch.agentFolders[2].name).toBe('Clients')
    expect(patch.agentFolderAssignments).toEqual({ sales: patch.agentFolders[2].id })
  })

  it('deduplicates a typed name that collides with an existing folder', async () => {
    const settings = { agentFolders: FOLDERS, agentFolderAssignments: {} }
    mockUserSettings.mockReturnValue(settings)
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    await userEvent.click(screen.getByTestId('move-agent-to-new-folder-item'))
    await userEvent.type(screen.getByTestId('new-agent-folder-name-input'), 'Work')
    await userEvent.click(screen.getByTestId('confirm-new-agent-folder-button'))

    const patch = patchWith(settings)
    expect(patch.agentFolders[2].name).toBe('Work 2')
  })

  it('does not create a folder with a blank name', async () => {
    mockUserSettings.mockReturnValue({ agentFolders: [], agentFolderAssignments: {} })
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    await userEvent.click(screen.getByTestId('move-agent-to-new-folder-item'))
    await userEvent.type(screen.getByTestId('new-agent-folder-name-input'), '   ')

    expect(screen.getByTestId('confirm-new-agent-folder-button')).toBeDisabled()
    expect(mockUpdateSettings).not.toHaveBeenCalled()
  })

  it('offers only New Folder when there is nowhere to move the agent yet', () => {
    // No folders and the agent in the default one: the destination list is
    // empty, so New Folder stands alone with no rule above it.
    mockUserSettings.mockReturnValue(undefined)
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    const submenu = screen.getByTestId('move-agent-to-folder-menu')
    expect(within(submenu).queryByTestId('move-agent-to-no-folder-item')).not.toBeInTheDocument()
    expect(within(submenu).queryByRole('separator')).not.toBeInTheDocument()
    expect(within(submenu).getByTestId('move-agent-to-new-folder-item')).toBeInTheDocument()
  })
})

// One menu for every entry point: the sidebar row, the home card, the
// breadcrumb and the agent home's three-dot button all render this component,
// so what it offers is what all of them offer.
describe('the unified agent menu', () => {
  it('offers every per-agent setting to an owner, and no separate settings dialog', () => {
    renderMenu()

    expect(screen.getByTestId('rename-agent-item')).toHaveTextContent('Rename Agent')
    expect(screen.getByTestId('export-agent-item')).toBeInTheDocument()
    expect(screen.getByTestId('open-agent-directory-item')).toBeInTheDocument()
    expect(screen.getByTestId('move-agent-to-folder-trigger')).toBeInTheDocument()
    expect(screen.getByTestId('delete-agent-item')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-settings-item')).not.toBeInTheDocument()
    expect(screen.queryByTestId('leave-agent-item')).not.toBeInTheDocument()
  })

  it('keeps owner-only settings away from a plain user, who can still file and leave', () => {
    mockUser.mockReturnValue(PLAIN_USER)
    renderMenu()

    expect(screen.queryByTestId('rename-agent-item')).not.toBeInTheDocument()
    expect(screen.queryByTestId('export-agent-item')).not.toBeInTheDocument()
    expect(screen.queryByTestId('open-agent-directory-item')).not.toBeInTheDocument()
    expect(screen.queryByTestId('delete-agent-item')).not.toBeInTheDocument()
    expect(screen.getByTestId('move-agent-to-folder-trigger')).toBeInTheDocument()
    expect(screen.getByTestId('leave-agent-item')).toBeInTheDocument()
  })
})

describe('renaming an agent', () => {
  it('hands off to the inline title once the menu has closed, keeping focus out of the menu', async () => {
    const onRename = vi.fn()
    renderMenu({ onRename })

    await userEvent.click(screen.getByTestId('rename-agent-item'))
    // Not yet: the modal menu's focus trap would pull the input's autofocus
    // back into the menu while it is still open.
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByTestId('rename-agent-dialog')).not.toBeInTheDocument()

    const close = { preventDefault: vi.fn() }
    act(() => menuClose.current?.(close))

    expect(onRename).toHaveBeenCalledTimes(1)
    // ...and the closing menu must not hand focus back to whatever opened it.
    expect(close.preventDefault).toHaveBeenCalled()
  })

  it('lets the closing menu restore focus normally when nothing is pending', () => {
    renderMenu({ onRename: vi.fn() })

    const close = { preventDefault: vi.fn() }
    act(() => menuClose.current?.(close))

    expect(close.preventDefault).not.toHaveBeenCalled()
  })

  it('opens a rename dialog elsewhere and saves the trimmed name', async () => {
    renderMenu()

    await userEvent.click(screen.getByTestId('rename-agent-item'))
    const input = screen.getByTestId('rename-agent-name-input')
    expect(input).toHaveValue('Sales')

    await userEvent.clear(input)
    await userEvent.type(input, '  Sales Team  ')
    await userEvent.click(screen.getByTestId('confirm-rename-agent-button'))

    await waitFor(() =>
      expect(mockUpdateAgent).toHaveBeenCalledWith({ slug: 'sales', name: 'Sales Team' }),
    )
    await waitFor(() => expect(screen.queryByTestId('rename-agent-dialog')).not.toBeInTheDocument())
  })

  it('does not write when the name is unchanged', async () => {
    renderMenu()

    await userEvent.click(screen.getByTestId('rename-agent-item'))
    await userEvent.click(screen.getByTestId('confirm-rename-agent-button'))

    expect(mockUpdateAgent).not.toHaveBeenCalled()
    expect(screen.queryByTestId('rename-agent-dialog')).not.toBeInTheDocument()
  })
})

describe('exporting an agent', () => {
  it('opens the Share popover on its Export pane once the menu has closed, on the agent home', async () => {
    const onExport = vi.fn()
    renderMenu({ onExport })

    await userEvent.click(screen.getByTestId('export-agent-item'))
    expect(onExport).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()

    const close = { preventDefault: vi.fn() }
    act(() => menuClose.current?.(close))

    expect(onExport).toHaveBeenCalledTimes(1)
    expect(close.preventDefault).toHaveBeenCalled()
  })

  it('parks the action and navigates to the agent home once the menu has closed, from anywhere else', async () => {
    renderMenu()

    await userEvent.click(screen.getByTestId('export-agent-item'))
    // Not on click: if the agent home is already underneath, the popover
    // would open while the menu is still closing and be dismissed by the
    // menu handing focus back to its trigger.
    expect(mockSetPendingAgentHomeAction).not.toHaveBeenCalled()

    const close = { preventDefault: vi.fn() }
    act(() => menuClose.current?.(close))

    expect(mockSetPendingAgentHomeAction).toHaveBeenCalledWith({ slug: 'sales', action: 'export' })
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents/$slug', params: { slug: 'sales-x1' } })
    expect(close.preventDefault).toHaveBeenCalled()
  })
})

describe('the agent directory item', () => {
  it('opens the workspace folder panel once the menu has closed, on the agent home', async () => {
    const onOpenDirectory = vi.fn()
    renderMenu({ onOpenDirectory })

    await userEvent.click(screen.getByTestId('open-agent-directory-item'))
    expect(onOpenDirectory).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()

    act(() => menuClose.current?.({ preventDefault: vi.fn() }))

    expect(onOpenDirectory).toHaveBeenCalledTimes(1)
  })

  it('parks the action and navigates to the agent home once the menu has closed, from anywhere else', async () => {
    renderMenu()

    await userEvent.click(screen.getByTestId('open-agent-directory-item'))
    expect(mockSetPendingAgentHomeAction).not.toHaveBeenCalled()

    act(() => menuClose.current?.({ preventDefault: vi.fn() }))

    expect(mockSetPendingAgentHomeAction).toHaveBeenCalledWith({ slug: 'sales', action: 'directory' })
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents/$slug', params: { slug: 'sales-x1' } })
  })
})
