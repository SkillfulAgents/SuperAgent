// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DirectoryInstallStatus, TeamDirectoriesResponse } from '@shared/lib/team-directory/view-schema'

const state = vi.hoisted(() => ({
  data: null as TeamDirectoriesResponse | null,
  test: vi.fn(),
  connect: vi.fn(),
  refresh: vi.fn(),
  disconnect: vi.fn(),
  connectProvisioning: vi.fn(),
  disconnectProvisioning: vi.fn(),
  startInstall: vi.fn(),
  cancelInstall: vi.fn(),
  installStatus: undefined as DirectoryInstallStatus | undefined,
  loginOpen: vi.fn(),
  loginClose: vi.fn(),
  invalidate: vi.fn(),
  relay: { available: true } as { available: boolean },
}))
vi.mock('@renderer/hooks/use-webhook-relay', () => ({ useWebhookRelay: () => ({ data: state.relay }) }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: state.invalidate }) }))
vi.mock('@renderer/hooks/use-login-window', () => ({
  useLoginWindow: () => ({ open: state.loginOpen, close: state.loginClose, pending: false, waiting: state.loginOpen.mock.calls.length > 0, canCancel: false, isLoginWindow: () => false }),
}))
vi.mock('@renderer/hooks/use-team-directories', () => ({
  useStartDirectoryInstall: () => ({ mutateAsync: state.startInstall, isPending: false }),
  useCancelDirectoryInstall: () => ({ mutate: state.cancelInstall }),
  useDirectoryInstallStatus: () => ({ data: state.installStatus }),
  useTeamDirectories: () => ({ data: state.data, isLoading: false, error: null }),
  useTestDirectoryCredentials: () => ({ mutateAsync: state.test, isPending: false }),
  useConnectTeamDirectory: () => ({ mutateAsync: state.connect, isPending: false }),
  useRefreshTeamDirectory: () => ({ mutateAsync: state.refresh, isPending: false }),
  useDisconnectTeamDirectory: () => ({ mutateAsync: state.disconnect, isPending: false }),
  useConnectProvisioning: () => ({ mutateAsync: state.connectProvisioning, isPending: false }),
  useDisconnectProvisioning: () => ({ mutateAsync: state.disconnectProvisioning, isPending: false }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true }) }))
import { toast } from 'sonner'
import { TeamDirectoryTab } from './team-directory-tab'

const slack = {
  id: 'slack',
  label: 'Slack',
  description: 'Find people in your Slack workspace.',
  fields: [{ key: 'botToken', label: 'Bot User OAuth Token', placeholder: 'xoxb-…', secret: true }],
  steps: ['Create the app.', 'Install it.', 'Paste the token.'],
  setupLink: { label: 'Create the Slack app', href: 'https://api.slack.com/apps?new_app=1' },
}
const other = { id: 'other', label: 'Other', description: 'Another directory.', fields: [{ key: 'apiKey', label: 'API key' }], steps: ['Paste the key.'] }
const acme = {
  id: 'd1', provider: 'slack', providerLabel: 'Slack', tenantName: 'Acme', status: 'active' as const,
  errorMessage: null, connectedBy: 'Ada Admin', connectedAt: Date.UTC(2026, 10, 1),
}

/** Slack as it is offered when the app configuration token can connect it. */
const slackByToken = {
  ...slack,
  provisioning: {
    description: 'Create each agent its own Slack app.',
    fields: [{ key: 'refreshToken', label: 'Refresh token', placeholder: 'xoxe-1-…', secret: true }],
    steps: ['Generate a token in Slack, then paste its refresh token below.'],
    setupLink: { label: 'Open Slack', href: 'https://api.slack.com/apps' },
    connectsDirectory: true,
  },
}

beforeEach(() => {
  vi.resetAllMocks()
  state.data = { providers: [slack], directories: [] }
  state.installStatus = undefined
  state.relay = { available: true }
  state.loginOpen.mockResolvedValue('waiting')
  state.disconnect.mockResolvedValue({ appLeftBehind: false })
})
afterEach(cleanup)

describe('connecting with one token', () => {
  it('pastes the token, then one Install connects the directory', async () => {
    state.data = { providers: [slackByToken], directories: [] }
    const { rerender } = render(<TeamDirectoryTab />)
    expect(screen.getByText('Step 1 of 2 · Add a token')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open Slack/ })).toHaveAttribute('href', 'https://api.slack.com/apps')
    expect(screen.queryByLabelText('Bot User OAuth Token')).not.toBeInTheDocument()
    const proceed = screen.getByRole('button', { name: 'Continue' })
    expect(proceed).toBeDisabled()

    state.startInstall.mockResolvedValue({ installId: 'i1', url: 'https://slack.com/oauth/v2/authorize?state=s1' })
    await userEvent.type(screen.getByLabelText('Refresh token'), 'xoxe-1-refresh')
    await userEvent.click(proceed)
    expect(state.startInstall).toHaveBeenCalledWith({ provider: 'slack', credentials: { refreshToken: 'xoxe-1-refresh' } })

    expect(await screen.findByText('Step 2 of 2 · Install')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Install on Slack' }))
    expect(await state.loginOpen.mock.calls[0][0]()).toBe('https://slack.com/oauth/v2/authorize?state=s1')

    state.installStatus = { status: 'connected', directoryId: 'd1', tenantName: 'Acme', notices: [] }
    rerender(<TeamDirectoryTab />)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Connected Acme', undefined))
    expect(state.invalidate).toHaveBeenCalled()
    expect(screen.getByText('Step 1 of 2 · Add a token')).toBeInTheDocument()
    expect(screen.getByLabelText('Refresh token')).toHaveValue('')
  })

  it('keeps the Install step after a cancel, and starts again after a failure', async () => {
    state.data = { providers: [slackByToken], directories: [] }
    state.startInstall.mockResolvedValue({ installId: 'i1', url: 'https://slack.com/oauth/v2/authorize?state=s1' })
    const { rerender } = render(<TeamDirectoryTab />)
    await userEvent.type(screen.getByLabelText('Refresh token'), 'xoxe-1-refresh')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Install on Slack' }))

    state.installStatus = { status: 'cancelled', at: 1 }
    rerender(<TeamDirectoryTab />)
    expect(await screen.findByText('The install was cancelled. Install again when you’re ready.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install on Slack' })).toBeEnabled()

    state.installStatus = { status: 'failed', error: 'Slack did not create the app (invalid_manifest).' }
    rerender(<TeamDirectoryTab />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Slack did not create the app (invalid_manifest).')
    expect(screen.getByText('Step 1 of 2 · Add a token')).toBeInTheDocument()
  })

  it('starts over with an empty form, deleting the app it made, and keeps Install open after the window closes', async () => {
    state.data = { providers: [slackByToken], directories: [] }
    state.startInstall.mockResolvedValue({ installId: 'i1', url: 'https://slack.com/oauth/v2/authorize?state=s1' })
    render(<TeamDirectoryTab />)
    await userEvent.type(screen.getByLabelText('Refresh token'), 'xoxe-1-refresh')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    const install = await screen.findByRole('button', { name: 'Install on Slack' })
    await userEvent.click(install)
    // The window may be closed without an answer: Install opens it again.
    expect(screen.getByRole('button', { name: 'Install on Slack' })).toBeEnabled()

    await userEvent.click(screen.getByRole('button', { name: 'Start over' }))
    expect(state.cancelInstall).toHaveBeenCalledWith('i1')
    // The pasted token was spent: the form doesn't offer it again.
    expect(screen.getByLabelText('Refresh token')).toHaveValue('')
  })

  it('shows why a token was refused', async () => {
    state.data = { providers: [slackByToken], directories: [] }
    state.startInstall.mockRejectedValue(new Error('Slack does not accept this refresh token.'))
    render(<TeamDirectoryTab />)
    await userEvent.type(screen.getByLabelText('Refresh token'), 'xoxe-1-old')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Slack does not accept this refresh token.')
  })

  it('still takes a bot token from an app the admin made', async () => {
    state.data = { providers: [slackByToken], directories: [] }
    render(<TeamDirectoryTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Use a Slack app you already have' }))
    expect(screen.getByLabelText('Bot User OAuth Token')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect Slack' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Let Gamut create the app instead' }))
    expect(screen.getByLabelText('Refresh token')).toBeInTheDocument()
  })
})

describe('Team Directory settings', () => {
  it('draws the connect form from what the provider describes', async () => {
    render(<TeamDirectoryTab />)
    expect(screen.getByText('No directory connected yet.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Create the Slack app/ })).toHaveAttribute('href', slack.setupLink.href)
    const connect = screen.getByRole('button', { name: 'Connect Slack' })
    expect(connect).toBeDisabled()

    state.test.mockResolvedValue({ tenantName: 'Acme' })
    await userEvent.type(screen.getByLabelText('Bot User OAuth Token'), 'xoxb-123')
    await userEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(state.test).toHaveBeenCalledWith({ provider: 'slack', credentials: { botToken: 'xoxb-123' } })
    expect(await screen.findByText('Works with Acme')).toBeInTheDocument()

    state.connect.mockResolvedValue({ directory: acme })
    await userEvent.click(connect)
    expect(state.connect).toHaveBeenCalledWith({ provider: 'slack', credentials: { botToken: 'xoxb-123' } })
    await waitFor(() => expect(screen.getByLabelText('Bot User OAuth Token')).toHaveValue(''))
  })

  it('shows why credentials were refused', async () => {
    state.test.mockRejectedValue(new Error('The token is missing users:read.email.'))
    render(<TeamDirectoryTab />)
    await userEvent.type(screen.getByLabelText('Bot User OAuth Token'), 'xoxb-123')
    await userEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('missing users:read.email')
  })

  it('lets the admin pick between providers when there are several', async () => {
    state.data = { providers: [slack, other], directories: [] }
    render(<TeamDirectoryTab />)
    await userEvent.click(screen.getByRole('radio', { name: 'Other' }))
    expect(screen.getByLabelText('API key')).not.toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'Connect Other' })).toBeInTheDocument()
  })

  it('lists connected directories, checks one, and disconnects it after confirming', async () => {
    state.data = { providers: [slack], directories: [acme, { ...acme, id: 'd2', tenantName: 'Beta', status: 'error', errorMessage: 'Slack does not accept this token.' }] }
    render(<TeamDirectoryTab />)
    expect(screen.getAllByTestId('team-directory-row')).toHaveLength(2)
    expect(screen.getByText('Slack does not accept this token.')).toBeInTheDocument()

    state.refresh.mockResolvedValue({ ok: true, userCount: 42, directory: acme })
    await userEvent.click(screen.getByRole('button', { name: 'Check Acme' }))
    expect(state.refresh).toHaveBeenCalledWith('d1')
    expect(toast.success).toHaveBeenCalledWith('Found 42 people in Acme')

    state.disconnect.mockResolvedValue(undefined)
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect Acme' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    expect(state.disconnect).toHaveBeenCalledWith('d1')
  })

  it('adds the token that lets a directory create agents’ apps, from the form its provider describes', async () => {
    const provisioning = {
      description: 'Create each agent its own Slack app.',
      fields: [{ key: 'accessToken', label: 'App configuration token', secret: true }, { key: 'refreshToken', label: 'Refresh token', secret: true }],
      steps: ['Generate a token.'],
    }
    state.data = { providers: [{ ...slack, provisioning }], directories: [{ ...acme, provisioning: { status: null, error: null } }] }
    state.connectProvisioning.mockResolvedValue({ directory: acme })
    render(<TeamDirectoryTab />)
    const panel = screen.getByTestId('team-directory-provisioning-d1')
    expect(panel).toHaveTextContent('Not set up')
    await userEvent.type(screen.getByLabelText('App configuration token'), 'xoxe.xoxp-1')
    await userEvent.type(screen.getByLabelText('Refresh token'), 'xoxe-1')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(state.connectProvisioning).toHaveBeenCalledWith({ id: 'd1', credentials: { accessToken: 'xoxe.xoxp-1', refreshToken: 'xoxe-1' } })
  })

  it('says when the token stopped renewing, and that installed apps keep working', () => {
    state.data = {
      providers: [{ ...slack, provisioning: { description: 'Apps.', fields: [{ key: 'accessToken', label: 'Token' }], steps: [] } }],
      directories: [{ ...acme, provisioning: { status: 'needs_reconnect', error: 'Slack no longer renews the app configuration token (invalid_refresh_token).' } }],
    }
    render(<TeamDirectoryTab />)
    const panel = screen.getByTestId('team-directory-provisioning-d1')
    expect(panel).toHaveTextContent('Needs a new token')
    expect(panel).toHaveTextContent('Apps already installed keep working.')
  })

  it('warns when the app Gamut made for a directory couldn’t be deleted with it', async () => {
    state.data = { providers: [slack], directories: [acme] }
    state.disconnect.mockResolvedValue({ appLeftBehind: true })
    render(<TeamDirectoryTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect Acme' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('The Slack app Gamut made for Acme couldn’t be deleted. Delete it in Slack yourself.'))
  })

  it('says agents are set up by hand while this host has no webhook relay', () => {
    const directory = { ...acme, provisioning: { status: 'active' as const, error: null } }
    state.data = { providers: [{ ...slack, provisioning: { description: 'Apps.', fields: [], steps: [] } }], directories: [directory] }
    const { unmount } = render(<TeamDirectoryTab />)
    expect(screen.queryByTestId('provisioning-needs-relay')).toBeNull()
    unmount()
    state.relay = { available: false }
    render(<TeamDirectoryTab />)
    expect(screen.getByTestId('provisioning-needs-relay')).toHaveTextContent('Until it’s connected, agents are set up by hand.')
  })
})
