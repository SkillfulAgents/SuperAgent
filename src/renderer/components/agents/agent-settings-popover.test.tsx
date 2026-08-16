// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mockApiFetch }))

vi.mock('@renderer/hooks/use-agents', () => ({
  useDeleteAgent: () => ({ mutateAsync: vi.fn() }),
  useRouteAgentId: () => undefined,
}))
vi.mock('@renderer/hooks/use-agent-preferences', () => ({
  useAgentPreferences: () => ({ data: undefined }),
  useUpdateAgentPreferences: () => ({ mutate: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({ useSettings: () => ({ data: undefined }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Radix popovers portal their content and need real pointer plumbing jsdom
// lacks; render trigger and content inline so the items are reachable.
vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    align,
    onCloseAutoFocus,
    ...props
  }: { align?: string; onCloseAutoFocus?: unknown } & React.HTMLAttributes<HTMLDivElement>) => {
    void align
    void onCloseAutoFocus
    return <div {...props}>{children}</div>
  },
}))

import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'
import { AgentSettingsPopover } from './agent-settings-popover'

/**
 * `open: true` makes the API run the file manager on ITS OWN host. Right when
 * the API is this computer; against a cloud workspace it asks the deployment to
 * launch `open`/`explorer`/`xdg-open` where nobody is looking.
 *
 * (Moved here from agent-context-menu.test.tsx when the directory action moved
 * from the sidebar context menu to the header settings popover.)
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
    render(<AgentSettingsPopover agent={AGENT} onRename={vi.fn()} />)

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
    render(<AgentSettingsPopover agent={AGENT} onRename={vi.fn()} />)

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

    render(<AgentSettingsPopover agent={AGENT} onRename={vi.fn()} />)

    expect(screen.getByText('Copy Agent Directory Path')).toBeInTheDocument()
    expect(screen.queryByText('Show Agent Directory')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('open-agent-directory-item'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/srv/agents/sales'))
  })
})
