// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const complete = vi.fn()
let canSaveLogin = true
let otherMembers: number | null = 0
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
  useOtherAgentMemberCount: () => otherMembers,
}))
const savedLogins = vi.hoisted(() => ({
  logins: [] as Array<{ id: string; name: string; site: string; capturedAt: string }>,
  applied: false,
  settled: false,
  apply: vi.fn(),
}))
vi.mock('@renderer/hooks/use-saved-logins', () => ({
  useSavedLogins: () => ({
    logins: savedLogins.logins, applyingId: null, applied: savedLogins.applied, settled: savedLogins.settled, error: null, apply: savedLogins.apply,
  }),
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
    savedLogins.apply.mockClear()
    savedLogins.logins = []
    savedLogins.applied = false
    savedLogins.settled = false
    canSaveLogin = true
    otherMembers = 0
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

  it('renders with no pending request', () => {
    stream.pendingBrowserInputRequests = []
    renderTray()

    expect(screen.getByTestId('browser-drawer-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('browser-tray-save-login')).toBeNull()
  })

  it('offers no save option for other requests', async () => {
    const user = userEvent.setup()
    stream.pendingBrowserInputRequests = [{ toolUseId: 'tu-1', message: 'Solve the CAPTCHA.', requirements: [] }]
    renderTray()

    expect(screen.queryByTestId('browser-tray-save-login')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(complete).toHaveBeenLastCalledWith('tu-1', { saveLogin: false })
  })

  it('offers only the saved login until the user picks another account', async () => {
    const user = userEvent.setup()
    savedLogins.logins = [{ id: 'bc-1', name: 'supabase.com', site: 'supabase.com', capturedAt: '' }]
    stream.pendingBrowserInputRequests = [{ toolUseId: 'tu-1', message: 'Sign in to Supabase.', requirements: [], login: true }]
    renderTray()

    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    expect(screen.queryByTestId('browser-tray-save-login')).toBeNull()
    await user.click(screen.getByTestId('browser-tray-use-saved-login'))
    expect(savedLogins.apply).toHaveBeenCalledWith('bc-1', false)

    await user.click(screen.getByTestId('browser-tray-other-account'))
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
    expect(screen.getByTestId('browser-tray-other-account')).toHaveTextContent('Use saved login')
  })

  it('tells the user other members of a shared agent can use the saved login', () => {
    otherMembers = 2
    savedLogins.logins = [{ id: 'bc-1', name: 'supabase.com', site: 'supabase.com', capturedAt: '' }]
    stream.pendingBrowserInputRequests = [{ toolUseId: 'tu-1', message: 'Sign in to Supabase.', requirements: [], login: true }]
    renderTray()

    expect(screen.getByTestId('browser-tray-shared-notice')).toHaveTextContent(
      '2 other members can use this agent. It will stay signed in to supabase.com with your account, and to any other site you signed in to on the way, such as Google.',
    )
  })

  it('cannot use the saved login until the member count is known', () => {
    otherMembers = null
    savedLogins.logins = [{ id: 'bc-1', name: 'supabase.com', site: 'supabase.com', capturedAt: '' }]
    stream.pendingBrowserInputRequests = [{ toolUseId: 'tu-1', message: 'Sign in to Supabase.', requirements: [], login: true }]
    renderTray()

    expect(screen.getByTestId('browser-tray-use-saved-login')).toBeDisabled()
    expect(screen.queryByTestId('browser-tray-shared-notice')).toBeNull()
  })

  it('offers Done, without saving, when the saved login was applied but the request is still open', async () => {
    const user = userEvent.setup()
    savedLogins.logins = [{ id: 'bc-1', name: 'supabase.com', site: 'supabase.com', capturedAt: '' }]
    savedLogins.applied = true
    stream.pendingBrowserInputRequests = [{ toolUseId: 'tu-1', message: 'Sign in to Supabase.', requirements: [], login: true }]
    renderTray()

    expect(screen.queryByTestId('browser-tray-use-saved-login')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(complete).toHaveBeenLastCalledWith('tu-1', { saveLogin: false })
    expect(savedLogins.apply).not.toHaveBeenCalled()
  })

  it('shows no shared-agent notice on an agent only the user can use', () => {
    savedLogins.logins = [{ id: 'bc-1', name: 'supabase.com', site: 'supabase.com', capturedAt: '' }]
    stream.pendingBrowserInputRequests = [{ toolUseId: 'tu-1', message: 'Sign in to Supabase.', requirements: [], login: true }]
    renderTray()

    expect(screen.queryByTestId('browser-tray-shared-notice')).toBeNull()
  })

  it('replaces an existing saved login only when the user opts in', async () => {
    const user = userEvent.setup()
    savedLogins.logins = [{ id: 'bc-1', name: 'supabase.com', site: 'supabase.com', capturedAt: '' }]
    stream.pendingBrowserInputRequests = [{ toolUseId: 'tu-1', message: 'Sign in to Supabase.', requirements: [], login: true }]
    renderTray()

    await user.click(screen.getByTestId('browser-tray-other-account'))
    expect(screen.getByText('Replace saved login')).toBeInTheDocument()
    expect(screen.getByTestId('browser-tray-save-login')).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(complete).toHaveBeenLastCalledWith('tu-1', { saveLogin: false })

    await user.click(screen.getByTestId('browser-tray-save-login'))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(complete).toHaveBeenLastCalledWith('tu-1', { saveLogin: true })
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
