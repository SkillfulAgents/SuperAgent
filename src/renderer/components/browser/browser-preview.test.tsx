// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// --- Mocks (must be before component import) ---

vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: () => 'http://localhost:3000',
}))

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ pendingBrowserInputRequests: [] }),
  clearBrowserActive: vi.fn(),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canUseAgent: () => true }),
}))

// Mock lucide-react icons to simple spans
vi.mock('lucide-react', () => ({
  Globe: (props: any) => <span data-testid="icon-globe" {...props} />,
  ChevronUp: (props: any) => <span data-testid="icon-chevron-up" {...props} />,
  ChevronDown: (props: any) => <span data-testid="icon-chevron-down" {...props} />,
  X: (props: any) => <span data-testid="icon-x" {...props} />,
  MousePointerClick: (props: any) => <span data-testid="icon-mouse" {...props} />,
  Eye: (props: any) => <span data-testid="icon-eye" {...props} />,
  EyeOff: (props: any) => <span data-testid="icon-eye-off" {...props} />,
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
})

import { BrowserPreview } from './browser-preview'

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

describe('BrowserPreview multi-tab', () => {
  it('shows tab bar when tab_list message is received', async () => {
    render(<BrowserPreview {...defaultProps} />)
    // Wait for WS to connect
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
    render(<BrowserPreview {...defaultProps} />)
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

    // The viewing tab should be t2 (the active one) — it gets bg-background class
    const bButton = screen.getByText('B').closest('button')!
    expect(bButton.className).toContain('bg-background')
  })

  it('tab_switched message updates viewingTargetId', async () => {
    render(<BrowserPreview {...defaultProps} />)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    const ws = getLatestWs()
    // First, send tab_list to populate tabs
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

    // Then switch to t2
    act(() => {
      simulateWsMessage(ws, { type: 'tab_switched', targetId: 't2' })
    })

    const bButton = screen.getByText('B').closest('button')!
    expect(bButton.className).toContain('bg-background')
  })

  it('tab click sends switch_tab WS message and disables auto-follow', async () => {
    const user = userEvent.setup()
    render(<BrowserPreview {...defaultProps} />)
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

    // Auto-follow should be disabled — look for the EyeOff icon title
    expect(screen.getByTitle('Not following agent (click to follow)')).toBeInTheDocument()
  })

  it('toggle auto-follow sends follow_agent WS message', async () => {
    const user = userEvent.setup()
    render(<BrowserPreview {...defaultProps} />)
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

    // Initially autoFollow is true, click to disable
    await user.click(screen.getByTitle('Auto-following agent (click to pin)'))

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'follow_agent', enabled: false })
    )
  })

  it('falls back to agent active tab when viewed tab is closed', async () => {
    render(<BrowserPreview {...defaultProps} />)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    const ws = getLatestWs()

    // Set up 2 tabs, manually switch to t2
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

    // Switch to t2 via tab_switched
    act(() => {
      simulateWsMessage(ws, { type: 'tab_switched', targetId: 't2' })
    })

    // Now t2 is closed — new tab_list without t2
    act(() => {
      simulateWsMessage(ws, {
        type: 'tab_list',
        tabs: [
          { targetId: 't1', index: 0, url: 'https://a.com', title: 'A', active: true },
        ],
        activeTargetId: 't1',
      })
    })

    // Should fall back to t1 (agent's active tab) and re-enable auto-follow
    const aButton = screen.getByText('A').closest('button')!
    expect(aButton.className).toContain('bg-background')
    expect(screen.getByTitle('Auto-following agent (click to pin)')).toBeInTheDocument()
  })
})
