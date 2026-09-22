// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// The tray manager owns full screen; the browser tray only asks for it.
// Stand in for the content with the two controls the flow needs.
vi.mock('@renderer/components/browser/browser-tray-content', () => ({
  BrowserTrayContent: ({
    onClose,
    onToggleExpand,
    isExpanded,
  }: {
    onClose: () => void
    onToggleExpand: () => void
    isExpanded: boolean
  }) => (
    <div data-testid="browser-drawer-panel">
      <button onClick={onToggleExpand}>{isExpanded ? 'Exit full screen' : 'Full screen'}</button>
      <button onClick={onClose}>Hide browser panel</button>
    </div>
  ),
}))
vi.mock('@renderer/components/file-preview/file-preview-tray-content', () => ({ FilePreviewTrayContent: () => null }))
vi.mock('@renderer/components/workflow/workflow-tray-content', () => ({ WorkflowTrayContent: () => null }))
vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ openTabs: [], isOpen: false, close: vi.fn() }),
}))
vi.mock('@renderer/context/workflow-context', () => ({
  useWorkflow: () => ({ openWorkflows: [], isOpen: false, close: vi.fn(), selectedRunId: null }),
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
    render(<TrayManager agentSlug="a" sessionId="s" browserActive={true} />)
    await flushFrames()

    await user.click(screen.getByText('Full screen'))
    expect(drawer()).toHaveAttribute('data-fullscreen')
    expect(sidebar.setOpen).toHaveBeenLastCalledWith(false)

    // Hide the drawer while in full screen: the sidebar must come back.
    await user.click(screen.getByText('Hide browser panel'))
    expect(screen.queryByTestId('tray-drawer')).toBeNull()
    expect(sidebar.setOpen).toHaveBeenLastCalledWith(true)

    // Reopen: a normal drawer, not a full-screen one.
    await user.click(screen.getByTitle('Show panel'))
    await flushFrames()
    expect(drawer()).not.toHaveAttribute('data-fullscreen')
    expect(screen.getByText('Full screen')).toBeInTheDocument()
  })

  it('leaves full screen and restores the sidebar when the browser goes idle', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TrayManager agentSlug="a" sessionId="s" browserActive={true} />)
    await flushFrames()
    await user.click(screen.getByText('Full screen'))
    expect(drawer()).toHaveAttribute('data-fullscreen')

    rerender(<TrayManager agentSlug="a" sessionId="s" browserActive={false} />)
    await flushFrames()
    expect(screen.queryByTestId('tray-drawer')).toBeNull()
    expect(sidebar.setOpen).toHaveBeenLastCalledWith(true)

    // The browser comes back: normal drawer again.
    rerender(<TrayManager agentSlug="a" sessionId="s" browserActive={true} />)
    await flushFrames()
    expect(drawer()).not.toHaveAttribute('data-fullscreen')
  })

  it('does not reopen the sidebar on exit if it was already closed before full screen', async () => {
    sidebar.open = false
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="s" browserActive={true} />)
    await flushFrames()
    await user.click(screen.getByText('Full screen'))
    await user.click(screen.getByText('Exit full screen'))
    expect(sidebar.setOpen).not.toHaveBeenCalledWith(true)
  })

  it('only exits on an Escape that has not already been handled', async () => {
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="s" browserActive={true} />)
    await flushFrames()
    await user.click(screen.getByText('Full screen'))
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    handled.preventDefault()
    fireEvent(window, handled)
    expect(drawer()).toHaveAttribute('data-fullscreen')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(drawer()).not.toHaveAttribute('data-fullscreen')
    expect(sidebar.setOpen).toHaveBeenLastCalledWith(true)
  })
})
