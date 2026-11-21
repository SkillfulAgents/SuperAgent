// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// The tray manager owns full screen and hide: both sit at the end of its strip,
// whatever tab is in front. Stand in for the tab bodies.
vi.mock('@renderer/components/browser/browser-tray-content', () => ({
  BrowserTrayContent: () => <div data-testid="browser-drawer-panel" />,
}))
vi.mock('@renderer/components/file-preview/file-preview-tray-content', () => ({ FilePreviewTrayContent: () => null }))
vi.mock('@renderer/components/workflow/workflow-tray-content', () => ({ WorkflowTrayContent: () => null }))
vi.mock('./subagents-tray-content', async (importOriginal) => ({ ...(await importOriginal<typeof import('./subagents-tray-content')>()), SubagentsTrayContent: () => null }))
vi.mock('@renderer/context/file-preview-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/context/file-preview-context')>()),
  useFilePreview: () => ({ openTabs: [], activeTabIndex: 0, isOpen: false, focus: null, close: vi.fn(), setActiveTab: vi.fn(), closeTab: vi.fn() }),
}))
vi.mock('@renderer/context/workflow-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/context/workflow-context')>()),
  useWorkflow: () => ({ openWorkflows: [], subagents: { open: false, viewing: null }, focus: null, closeWorkflow: vi.fn(), closeSubagents: vi.fn(), openSubagent: vi.fn(), background: { open: false, viewing: null }, closeBackgroundTasks: vi.fn(), agentSessions: { open: false, viewing: null }, closeAgentSessions: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/hooks/use-agents')>()),
  useAgents: () => ({ data: [] }),
  useAgent: () => ({ data: null }),
}))
vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ workflows: [], activeSubagents: [], completedSubagents: null, isActive: false }),
}))
vi.mock('@shared/lib/tools/requests/use-pending-user-requests', () => ({
  usePendingUserRequests: () => ({ data: [] }),
}))

const sidebar = {
  open: true,
  setOpen: vi.fn((open: boolean) => {
    sidebar.open = open
  }),
}
vi.mock('@renderer/components/ui/sidebar', () => ({
  useSidebar: () => sidebar,
}))

import { TrayManager } from './tray-manager'

function drawer() {
  return screen.getByTestId('tray-drawer')
}

async function flushFrames() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  })
}

describe('TrayManager full screen', () => {
  beforeEach(() => {
    sidebar.open = true
    sidebar.setOpen.mockClear()
    localStorage.clear()
  })

  it('leaves full screen and restores the sidebar when the panel is hidden, and reopens at normal size', async () => {
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="s" browserActive={true} persistent />)
    await flushFrames()

    await user.click(screen.getByRole('button', { name: 'Full screen' }))
    expect(drawer()).toHaveAttribute('data-fullscreen')
    expect(sidebar.setOpen).toHaveBeenLastCalledWith(false)

    // Hide the drawer while in full screen: the sidebar must come back.
    await user.click(screen.getByRole('button', { name: 'Hide panel' }))
    expect(drawer()).toHaveClass('hidden')
    expect(drawer()).not.toHaveAttribute('data-fullscreen')
    expect(sidebar.setOpen).toHaveBeenLastCalledWith(true)

    // Reopen: a normal drawer, not a full-screen one.
    await user.click(screen.getByTitle('Show panel'))
    await flushFrames()
    expect(drawer()).not.toHaveAttribute('data-fullscreen')
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeInTheDocument()
  })

  it('leaves full screen and restores the sidebar when the browser goes idle', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TrayManager agentSlug="a" sessionId="s" browserActive={true} persistent />)
    await flushFrames()
    await user.click(screen.getByRole('button', { name: 'Full screen' }))
    expect(drawer()).toHaveAttribute('data-fullscreen')

    rerender(<TrayManager agentSlug="a" sessionId="s" browserActive={false} persistent />)
    await flushFrames()
    expect(screen.queryByTestId('tray-drawer')).toBeNull()
    expect(sidebar.setOpen).toHaveBeenLastCalledWith(true)

    // The browser comes back: normal drawer again.
    rerender(<TrayManager agentSlug="a" sessionId="s" browserActive={true} persistent />)
    await flushFrames()
    expect(drawer()).not.toHaveAttribute('data-fullscreen')
  })

  it('does not reopen the sidebar on exit if it was already closed before full screen', async () => {
    sidebar.open = false
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="s" browserActive={true} persistent />)
    await flushFrames()
    await user.click(screen.getByRole('button', { name: 'Full screen' }))
    await user.click(screen.getByRole('button', { name: 'Exit full screen' }))
    expect(sidebar.setOpen).not.toHaveBeenCalledWith(true)
  })

  it('only exits on an Escape that has not already been handled', async () => {
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="s" browserActive={true} persistent />)
    await flushFrames()
    await user.click(screen.getByRole('button', { name: 'Full screen' }))
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    handled.preventDefault()
    fireEvent(window, handled)
    expect(drawer()).toHaveAttribute('data-fullscreen')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(drawer()).not.toHaveAttribute('data-fullscreen')
    expect(sidebar.setOpen).toHaveBeenLastCalledWith(true)
  })
})
