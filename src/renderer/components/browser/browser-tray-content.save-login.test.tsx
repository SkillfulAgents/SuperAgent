// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const complete = vi.fn()
let canSaveLogin = true
const stream = {
  aspectRatio: '16 / 9',
  tabs: [],
  viewingTargetId: null,
  autoFollow: true,
  needsAttention: true,
  showOverlay: false,
  pendingBrowserInputRequests: [] as Array<{ toolUseId: string; message: string; requirements: string[]; login?: boolean }>,
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

vi.mock('@renderer/hooks/use-browser-stream', () => ({ useBrowserStream: () => stream }))
vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ browserActive: true, isActive: true, streamingToolUses: [], activeSubagents: [] }),
}))
vi.mock('@renderer/hooks/use-browser-input-actions', () => ({
  useBrowserInputActions: () => ({ status: 'idle', submittingAction: null, error: null, complete, decline: vi.fn() }),
  useCanSaveBrowserLogin: () => canSaveLogin,
}))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
}))

import { BrowserTrayContent } from './browser-tray-content'

function renderTray() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BrowserTrayContent agentSlug="agent-a" sessionId="s-1" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

describe('browser tray save login', () => {
  beforeEach(() => {
    complete.mockClear()
    canSaveLogin = true
  })

  it('saves a sign-in by default and lets the user opt out', async () => {
    const user = userEvent.setup()
    stream.pendingBrowserInputRequests = [{ toolUseId: 'tu-1', message: 'Sign in to LinkedIn.', requirements: [], login: true }]
    renderTray()

    expect(screen.getByTestId('browser-tray-save-login')).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(complete).toHaveBeenLastCalledWith('tu-1', { saveLogin: true })

    await user.click(screen.getByTestId('browser-tray-save-login'))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(complete).toHaveBeenLastCalledWith('tu-1', { saveLogin: false })
  })

  it('offers no save option for other requests', async () => {
    const user = userEvent.setup()
    stream.pendingBrowserInputRequests = [{ toolUseId: 'tu-1', message: 'Solve the CAPTCHA.', requirements: [] }]
    renderTray()

    expect(screen.queryByTestId('browser-tray-save-login')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(complete).toHaveBeenLastCalledWith('tu-1', { saveLogin: false })
  })

  it('offers no save option on a shared agent', async () => {
    const user = userEvent.setup()
    canSaveLogin = false
    stream.pendingBrowserInputRequests = [{ toolUseId: 'tu-1', message: 'Sign in to LinkedIn.', requirements: [], login: true }]
    renderTray()

    expect(screen.queryByTestId('browser-tray-save-login')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(complete).toHaveBeenLastCalledWith('tu-1', { saveLogin: false })
  })

  it('starts the next sign-in request checked after opting out of one', async () => {
    const user = userEvent.setup()
    stream.pendingBrowserInputRequests = [{ toolUseId: 'tu-1', message: 'Sign in to LinkedIn.', requirements: [], login: true }]
    const { rerender } = renderTray()
    await user.click(screen.getByTestId('browser-tray-save-login'))
    expect(screen.getByTestId('browser-tray-save-login')).not.toBeChecked()

    stream.pendingBrowserInputRequests = [{ toolUseId: 'tu-2', message: 'Enter the 2FA code.', requirements: [], login: true }]
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BrowserTrayContent agentSlug="agent-a" sessionId="s-1" onClose={vi.fn()} />
      </QueryClientProvider>,
    )
    expect(screen.getByTestId('browser-tray-save-login')).toBeChecked()
  })
})
