// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

// The card reuses the tray's pieces over the same stream hook; what it must not
// carry into a video tile are the controls (stop, full screen) that only a
// person at the keyboard could use.
const stream = {
  aspectRatio: '16 / 9',
  tabs: [{ targetId: 't-1', index: 0, title: 'Quotes', url: 'https://example.com/quotes', active: true }],
  viewingTargetId: 't-1',
  pageUrl: 'https://example.com/quotes',
  canGoBack: false,
  canGoForward: false,
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
}

const useBrowserStream = vi.fn((_options: unknown) => stream)
vi.mock('@renderer/hooks/use-browser-stream', () => ({
  useBrowserStream: (options: unknown) => useBrowserStream(options),
}))

import { MeetingBrowserCard } from './meeting-browser-card'

describe('MeetingBrowserCard', () => {
  it('shows the tray chrome and screencast without the stop and full-screen controls', () => {
    render(<MeetingBrowserCard agentSlug="research" sessionId="s-1" isActive={true} width={760} />)

    expect(screen.getByTestId('browser-canvas')).toBeInTheDocument()
    expect(screen.getByTestId('browser-tray-url')).toHaveTextContent('https://example.com/quotes')
    expect(screen.getByText('Quotes')).toBeInTheDocument()
    expect(screen.queryByTestId('browser-tray-pill')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop browser agent' })).not.toBeInTheDocument()
    // Nobody in the room can steer the page: input never reaches the stream, whatever the role.
    fireEvent.mouseDown(screen.getByTestId('browser-canvas'))
    fireEvent.keyDown(screen.getByTestId('browser-canvas'), { key: 'a' })
    expect(stream.handleMouseDown).not.toHaveBeenCalled()
    expect(stream.handleKeyDown).not.toHaveBeenCalled()
    expect(screen.getByTestId('browser-canvas')).toHaveAttribute('tabindex', '-1')
  })

  it('follows the session browser as a connected, view-only watcher', () => {
    render(<MeetingBrowserCard agentSlug="research" sessionId="s-1" isActive={false} width={760} />)

    expect(useBrowserStream).toHaveBeenCalledWith(expect.objectContaining({
      agentSlug: 'research',
      sessionId: 's-1',
      browserActive: true,
      isConnected: true,
    }))
  })
})
