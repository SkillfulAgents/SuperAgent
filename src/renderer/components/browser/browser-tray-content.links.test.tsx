// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const CLAY_URL = 'https://app.clay.com/oauth/device?user_code=LCWW-PKKC'

// The tray action bar renders the same agent-authored prose the in-chat card
// does, but reaches it through the browser stream rather than RequestItemShell.
// The shell's linkify call cannot cover it, so this pins its own call site.
const stream = {
  aspectRatio: 16 / 9,
  tabs: [],
  viewingTargetId: null,
  autoFollow: true,
  needsAttention: true,
  showOverlay: false,
  pendingBrowserInputRequests: [{ toolUseId: 'tu-1', message: `Sign in at ${CLAY_URL}` }],
  dismissBrowserInputRequest: vi.fn(),
  latestRequestId: 'tu-1',
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

vi.mock('@renderer/hooks/use-browser-stream', () => ({
  useBrowserStream: () => stream,
}))

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

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
}))

import { BrowserTrayContent } from './browser-tray-content'

describe('browser tray action bar', () => {
  it('renders a URL in the pending request message as a clickable link', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BrowserTrayContent agentSlug="prospecting" sessionId="s-1" onClose={vi.fn()} />
      </QueryClientProvider>
    )

    expect(screen.getByRole('link', { name: CLAY_URL })).toHaveAttribute('href', CLAY_URL)
  })
})
