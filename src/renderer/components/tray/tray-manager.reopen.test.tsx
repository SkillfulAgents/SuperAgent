// @vitest-environment jsdom
// The full-screen tests above stand in for the browser tray; this one mounts
// the real tray content through the flow that was reported to break: full
// screen, hide the panel, show it again.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiMessage } from '@shared/lib/types/api'

const stream = {
  aspectRatio: '16 / 9',
  tabs: [{ targetId: 't1', index: 0, url: 'https://www.amazon.com/', title: 'Amazon.com', active: true }],
  viewingTargetId: 't1',
  autoFollow: true,
  needsAttention: false,
  showOverlay: false,
  pendingBrowserInputRequests: [],
  dismissBrowserInputRequest: vi.fn(),
  latestRequestId: null,
  connected: true,
  pageLoading: false,
  isViewOnly: false,
  isClosing: false,
  showCloseWarning: false,
  setShowCloseWarning: vi.fn(),
  dismissOverlay: vi.fn(),
  closeBrowser: vi.fn(),
  handleCloseClick: vi.fn(),
  handleMouseDown: vi.fn(),
  handleMouseUp: vi.fn(),
  handleMouseMove: vi.fn(),
  handleWheel: vi.fn(),
  handleKeyDown: vi.fn(),
  handleKeyUp: vi.fn(),
  handlePaste: vi.fn(),
  handleTabClick: vi.fn(),
  handleCloseTab: vi.fn(),
  toggleAutoFollow: vi.fn(),
  canGoBack: false,
  canGoForward: false,
  pageUrl: 'https://www.amazon.com/',
  navigate: vi.fn(),
}
vi.mock('@renderer/hooks/use-browser-stream', () => ({ useBrowserStream: () => stream }))
vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ browserActive: true, isActive: true, streamingToolUses: [], activeSubagents: [] }),
}))
vi.mock('@renderer/hooks/use-browser-input-actions', () => ({
  useBrowserInputActions: () => ({
    status: 'idle',
    submittingAction: null,
    error: null,
    complete: vi.fn(),
    decline: vi.fn(),
  }),
}))
const historyMessages: ApiMessage[] = []
vi.mock('@renderer/hooks/use-messages', () => ({ useMessages: () => ({ data: historyMessages }) }))
const mockApiFetch = vi.fn((_url: string) => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: (url: string) => mockApiFetch(url) }))
vi.mock('@renderer/components/messages/tool-renderers', () => ({ getToolRenderer: () => undefined }))
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
vi.mock('@renderer/components/ui/sidebar', () => ({ useSidebar: () => sidebar }))

import { TrayManager } from './tray-manager'

async function flushFrames() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  })
}

describe('TrayManager with the real browser tray', () => {
  beforeEach(() => {
    sidebar.open = true
    sidebar.setOpen.mockClear()
    localStorage.clear()
    historyMessages.length = 0
    mockApiFetch.mockClear()
    Element.prototype.scrollIntoView = vi.fn()
    // jsdom has no ResizeObserver; give it one so the full-screen measurement path runs.
    class RO {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('ResizeObserver', RO)
  })

  it('survives full screen → hide panel → show panel with the real content', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TrayManager agentSlug="a" sessionId="s" browserActive={true} />
      </QueryClientProvider>,
    )
    await flushFrames()
    expect(screen.getByTestId('browser-drawer-panel')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Full screen'))
    expect(screen.getByTestId('tray-drawer')).toHaveAttribute('data-fullscreen')
    expect(screen.getByLabelText('Exit full screen')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Hide browser panel'))
    expect(screen.queryByTestId('tray-drawer')).toBeNull()

    await user.click(screen.getByTitle('Show panel'))
    await flushFrames()
    expect(screen.getByTestId('tray-drawer')).not.toHaveAttribute('data-fullscreen')
    expect(screen.getByTestId('browser-drawer-panel')).toBeInTheDocument()
    expect(screen.getByLabelText('Full screen')).toBeInTheDocument()
    expect(screen.getByText('Browser agent actions')).toBeInTheDocument()

    const reactErrors = errors.mock.calls.filter((c) => /Cannot update|Warning|Error/.test(String(c[0])))
    expect(reactErrors).toEqual([])
    errors.mockRestore()
  })

  it('preserves log rows and avoids refetching historical transcripts after full screen', async () => {
    historyMessages.push({
      id: 'history',
      type: 'assistant',
      content: { text: '' },
      createdAt: new Date(),
      toolCalls: [
        ...Array.from({ length: 40 }, (_, index) => ({
          id: `task-${index}`,
          name: 'Agent',
          input: {},
          subagent: { agentId: `sub-${index}`, status: 'completed' },
        })),
        { id: 'browser-click', name: 'mcp__browser__click', input: {}, result: 'Persistent browser result' },
      ],
    })
    const user = userEvent.setup()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5000 } } })
    const view = render(
      <QueryClientProvider client={client}>
        <TrayManager agentSlug="a" sessionId="s" browserActive={true} />
      </QueryClientProvider>,
    )
    await flushFrames()
    await waitFor(() => expect(client.isFetching()).toBe(0))
    expect(mockApiFetch).toHaveBeenCalledTimes(40)
    await user.click(screen.getByRole('button', { name: 'click' }))
    const detail = screen.getByText('Persistent browser result')
    const scrollViewport = screen
      .getByTestId('browser-activity-region')
      .querySelector('[data-radix-scroll-area-viewport]')!
    scrollViewport.scrollTop = 80

    await user.click(screen.getByLabelText('Full screen'))
    expect(screen.getByTestId('browser-activity-region')).toHaveClass('hidden')
    // Exceed the application's five-second stale time without slowing the test.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000)
    try {
      await user.click(screen.getByLabelText('Exit full screen'))
      await waitFor(() => expect(client.isFetching()).toBe(0))
      expect(mockApiFetch).toHaveBeenCalledTimes(40)
      expect(screen.getByText('Persistent browser result')).toBe(detail)
      expect(screen.getByTestId('browser-activity-region')).not.toHaveClass('hidden')
      expect(scrollViewport.scrollTop).toBe(80)
    } finally {
      now.mockRestore()
      view.unmount()
      client.clear()
    }
  })
})
