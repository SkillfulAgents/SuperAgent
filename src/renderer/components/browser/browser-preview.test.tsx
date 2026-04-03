// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// --- Mocks (must be before component import) ---

vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: () => 'http://localhost:3000',
}))

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ pendingBrowserInputRequests: [], streamingToolUse: null }),
  clearBrowserActive: vi.fn(),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canUseAgent: () => true }),
}))

vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => ({ data: [] }),
}))

vi.mock('@renderer/components/messages/tool-renderers', () => ({
  getToolRenderer: () => undefined,
}))

// Mock lucide-react icons to simple spans
vi.mock('lucide-react', () => ({
  Globe: (props: any) => <span data-testid="icon-globe" {...props} />,
  ChevronUp: (props: any) => <span data-testid="icon-chevron-up" {...props} />,
  ChevronDown: (props: any) => <span data-testid="icon-chevron-down" {...props} />,
  X: (props: any) => <span data-testid="icon-x" {...props} />,
  Loader2: (props: any) => <span data-testid="icon-loader" {...props} />,
  MousePointerClick: (props: any) => <span data-testid="icon-mouse" {...props} />,
  Eye: (props: any) => <span data-testid="icon-eye" {...props} />,
  EyeOff: (props: any) => <span data-testid="icon-eye-off" {...props} />,
  Check: (props: any) => <span data-testid="icon-check" {...props} />,
}))

// Mock alert dialog to avoid Radix DOM issues
vi.mock('@renderer/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: any) => <div>{children}</div>,
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
  AlertDialogAction: (props: any) => <button {...props} />,
  AlertDialogCancel: (props: any) => <button {...props} />,
}))

// Mock Button component
vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

// Mock ScrollArea
vi.mock('@renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: any) => <div className={className}>{children}</div>,
  ScrollBar: () => null,
}))

// Track WebSocket instances
let wsInstances: MockWebSocket[] = []

class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  readyState = MockWebSocket.OPEN
  url: string
  onopen: (() => void) | null = null
  onmessage: ((event: { data: any }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn()
  close = vi.fn(() => { this.readyState = MockWebSocket.CLOSED })
  addEventListener = vi.fn()
  removeEventListener = vi.fn()

  constructor(url: string) {
    this.url = url
    wsInstances.push(this)
    // Auto-fire onopen in next tick
    setTimeout(() => this.onopen?.(), 0)
  }
}

// Also mock global fetch for the status check on ws close
const mockFetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ active: false }) }))

beforeEach(() => {
  wsInstances = []
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('fetch', mockFetch)
  // Mock canvas getContext
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage: vi.fn(),
    clearRect: vi.fn(),
  })) as any
  // Mock localStorage
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
  })
  // Mock requestAnimationFrame
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
})

import { BrowserDrawerPanel } from './browser-drawer-panel'

const defaultProps = {
  agentSlug: 'test-agent',
  sessionId: 'session-1',
  browserActive: true,
  isActive: true,
}

function getLatestWs(): MockWebSocket {
  return wsInstances[wsInstances.length - 1]
}

function simulateWsMessage(ws: MockWebSocket, data: Record<string, unknown>) {
  ws.onmessage?.({ data: JSON.stringify(data) })
}

describe('BrowserDrawerPanel', () => {
  it('renders the drawer when browserActive is true', async () => {
    render(<BrowserDrawerPanel {...defaultProps} />)
    expect(screen.getByTestId('browser-drawer-panel')).toBeInTheDocument()
  })

  it('does not render when browserActive is false', () => {
    render(<BrowserDrawerPanel {...defaultProps} browserActive={false} />)
    expect(screen.queryByTestId('browser-drawer-panel')).not.toBeInTheDocument()
  })

  it('shows "Browser" text in header', async () => {
    render(<BrowserDrawerPanel {...defaultProps} />)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
    // Use exact match to avoid colliding with "Close Browser" in dialog
    expect(screen.getByText('Browser (connecting...)')).toBeInTheDocument()
  })

  it('shows tab bar when tab_list message is received', async () => {
    render(<BrowserDrawerPanel {...defaultProps} />)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    const ws = getLatestWs()
    act(() => {
      simulateWsMessage(ws, {
        type: 'tab_list',
        tabs: [
          { targetId: 't1', index: 0, url: 'https://a.com', title: 'A', active: true },
          { targetId: 't2', index: 1, url: 'https://b.com', title: 'B', active: false },
        ],
        activeTargetId: 't1',
      })
    })

    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
  })

  it('auto-follow updates viewingTargetId from tab_list activeTargetId', async () => {
    render(<BrowserDrawerPanel {...defaultProps} />)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    const ws = getLatestWs()
    act(() => {
      simulateWsMessage(ws, {
        type: 'tab_list',
        tabs: [
          { targetId: 't1', index: 0, url: 'https://a.com', title: 'A', active: false },
          { targetId: 't2', index: 1, url: 'https://b.com', title: 'B', active: true },
        ],
        activeTargetId: 't2',
      })
    })

    const bButton = screen.getByText('B').closest('button')!
    expect(bButton.className).toContain('bg-background')
  })

  it('tab_switched message updates viewingTargetId', async () => {
    render(<BrowserDrawerPanel {...defaultProps} />)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    const ws = getLatestWs()
    act(() => {
      simulateWsMessage(ws, {
        type: 'tab_list',
        tabs: [
          { targetId: 't1', index: 0, url: 'https://a.com', title: 'A', active: true },
          { targetId: 't2', index: 1, url: 'https://b.com', title: 'B', active: false },
        ],
        activeTargetId: 't1',
      })
    })

    act(() => {
      simulateWsMessage(ws, { type: 'tab_switched', targetId: 't2' })
    })

    const bButton = screen.getByText('B').closest('button')!
    expect(bButton.className).toContain('bg-background')
  })

  it('tab click sends switch_tab WS message and disables auto-follow', async () => {
    const user = userEvent.setup()
    render(<BrowserDrawerPanel {...defaultProps} />)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    const ws = getLatestWs()
    act(() => {
      simulateWsMessage(ws, {
        type: 'tab_list',
        tabs: [
          { targetId: 't1', index: 0, url: 'https://a.com', title: 'A', active: true },
          { targetId: 't2', index: 1, url: 'https://b.com', title: 'B', active: false },
        ],
        activeTargetId: 't1',
      })
    })

    await user.click(screen.getByText('B'))

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'switch_tab', targetId: 't2' })
    )

    expect(screen.getByTitle('Not following agent (click to follow)')).toBeInTheDocument()
  })

  it('toggle auto-follow sends follow_agent WS message', async () => {
    const user = userEvent.setup()
    render(<BrowserDrawerPanel {...defaultProps} />)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    const ws = getLatestWs()
    act(() => {
      simulateWsMessage(ws, {
        type: 'tab_list',
        tabs: [
          { targetId: 't1', index: 0, url: 'https://a.com', title: 'A', active: true },
        ],
        activeTargetId: 't1',
      })
    })

    await user.click(screen.getByTitle('Auto-following agent (click to pin)'))

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'follow_agent', enabled: false })
    )
  })

  it('falls back to agent active tab when viewed tab is closed', async () => {
    render(<BrowserDrawerPanel {...defaultProps} />)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    const ws = getLatestWs()

    act(() => {
      simulateWsMessage(ws, {
        type: 'tab_list',
        tabs: [
          { targetId: 't1', index: 0, url: 'https://a.com', title: 'A', active: true },
          { targetId: 't2', index: 1, url: 'https://b.com', title: 'B', active: false },
        ],
        activeTargetId: 't1',
      })
    })

    act(() => {
      simulateWsMessage(ws, { type: 'tab_switched', targetId: 't2' })
    })

    act(() => {
      simulateWsMessage(ws, {
        type: 'tab_list',
        tabs: [
          { targetId: 't1', index: 0, url: 'https://a.com', title: 'A', active: true },
        ],
        activeTargetId: 't1',
      })
    })

    const aButton = screen.getByText('A').closest('button')!
    expect(aButton.className).toContain('bg-background')
    expect(screen.getByTitle('Auto-following agent (click to pin)')).toBeInTheDocument()
  })

  it('shows loading spinner when page_loading is true', async () => {
    render(<BrowserDrawerPanel {...defaultProps} />)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    const ws = getLatestWs()
    act(() => {
      simulateWsMessage(ws, {
        type: 'tab_list',
        tabs: [
          { targetId: 't1', index: 0, url: 'https://a.com', title: 'A', active: true },
        ],
        activeTargetId: 't1',
      })
    })

    expect(screen.queryByTestId('icon-loader')).not.toBeInTheDocument()

    act(() => {
      simulateWsMessage(ws, { type: 'page_loading', loading: true })
    })

    expect(screen.getByTestId('icon-loader')).toBeInTheDocument()

    act(() => {
      simulateWsMessage(ws, { type: 'page_loading', loading: false })
    })

    expect(screen.queryByTestId('icon-loader')).not.toBeInTheDocument()
  })

  it('shows activity section', async () => {
    render(<BrowserDrawerPanel {...defaultProps} />)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    expect(screen.getByText('Activity')).toBeInTheDocument()
    expect(screen.getByText('No browser activity yet')).toBeInTheDocument()
  })
})
