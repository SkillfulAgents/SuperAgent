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
// items inline so the action is reachable.
vi.mock('@renderer/components/ui/context-menu', async () => {
  const React = await import('react')
  return {
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
    // Radix routes the selection through context; the stub hands each item its
    // own value so a click reports the same thing the real menu would.
    ContextMenuRadioGroup: ({ children, value, onValueChange }: any) => (
      <div>
        {React.Children.map(children, (child) =>
          React.isValidElement<{ value: string }>(child)
            ? React.cloneElement(child as never, {
                onClick: () => onValueChange?.(child.props.value),
                'aria-checked': child.props.value === value,
              })
            : child
        )}
      </div>
    ),
    // aria-checked is spread in from the group above; the literal default is
    // there so the role is never rendered without its required attribute.
    ContextMenuRadioItem: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type="button" role="menuitemradio" aria-checked={false} onClick={onClick} {...props}>
        {children}
      </button>
    ),
  }
})

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
  mockUserSettings.mockReturnValue({ agentFolders: [], agentFolderAssignments: {} })
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

  it('lists every folder plus the default "Your Agents" option', () => {
    mockUserSettings.mockReturnValue({ agentFolders: FOLDERS, agentFolderAssignments: {} })
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    expect(screen.getByTestId('move-agent-to-no-folder-item')).toHaveTextContent('Your Agents')
    expect(screen.getByTestId('move-agent-to-folder-f1')).toHaveTextContent('Work')
    expect(screen.getByTestId('move-agent-to-folder-f2')).toHaveTextContent('Personal')
  })

  it('writes only the assignment, leaving the agent where it sits in the order', async () => {
    mockUserSettings.mockReturnValue({ agentFolders: FOLDERS, agentFolderAssignments: {} })
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    await userEvent.click(screen.getByTestId('move-agent-to-folder-f1'))

    expect(patchWith({ agentFolders: FOLDERS, agentFolderAssignments: {} })).toEqual({
      agentFolderAssignments: { sales: 'f1' },
    })
  })

  it('preserves other agents\u2019 assignments when filing this one', async () => {
    const settings = { agentFolders: FOLDERS, agentFolderAssignments: { support: 'f2' } }
    mockUserSettings.mockReturnValue(settings)
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    await userEvent.click(screen.getByTestId('move-agent-to-folder-f1'))

    expect(patchWith(settings)).toEqual({
      agentFolderAssignments: { support: 'f2', sales: 'f1' },
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

    expect(patchWith({ agentFolders: FOLDERS, agentFolderAssignments: { support: 'f2' } })).toEqual({
      agentFolderAssignments: { support: 'f2', sales: 'f1' },
    })
  })

  it('moving to "Your Agents" drops the key rather than storing a folder id', async () => {
    const settings = { agentFolders: FOLDERS, agentFolderAssignments: { sales: 'f1' } }
    mockUserSettings.mockReturnValue(settings)
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    await userEvent.click(screen.getByTestId('move-agent-to-no-folder-item'))

    expect(patchWith(settings)).toEqual({ agentFolderAssignments: {} })
  })

  it('marks the folder the agent is currently in', () => {
    mockUserSettings.mockReturnValue({
      agentFolders: FOLDERS,
      agentFolderAssignments: { sales: 'f2' },
    })
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    expect(screen.getByTestId('move-agent-to-folder-f2')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('move-agent-to-folder-f1')).toHaveAttribute('aria-checked', 'false')
  })

  it('reads an assignment naming a deleted folder as the default folder', () => {
    // The sidebar renders such an agent under "Your Agents", so the menu has
    // to agree rather than showing a checkmark against nothing.
    mockUserSettings.mockReturnValue({
      agentFolders: FOLDERS,
      agentFolderAssignments: { sales: 'gone' },
    })
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    expect(screen.getByTestId('move-agent-to-no-folder-item')).toHaveAttribute('aria-checked', 'true')
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

  it('offers the folder submenu with no folders defined yet', () => {
    mockUserSettings.mockReturnValue(undefined)
    render(<AgentContextMenu agent={AGENT}><span>row</span></AgentContextMenu>)

    expect(screen.getByTestId('move-agent-to-no-folder-item')).toBeInTheDocument()
    expect(screen.getByTestId('move-agent-to-new-folder-item')).toBeInTheDocument()
  })
})
