// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TeamDirectoriesResponse } from '@shared/lib/team-directory/view-schema'

const state = vi.hoisted(() => ({
  data: null as TeamDirectoriesResponse | null,
  test: vi.fn(),
  connect: vi.fn(),
  refresh: vi.fn(),
  disconnect: vi.fn(),
}))
vi.mock('@renderer/hooks/use-team-directories', () => ({
  useTeamDirectories: () => ({ data: state.data, isLoading: false, error: null }),
  useTestDirectoryCredentials: () => ({ mutateAsync: state.test, isPending: false }),
  useConnectTeamDirectory: () => ({ mutateAsync: state.connect, isPending: false }),
  useRefreshTeamDirectory: () => ({ mutateAsync: state.refresh, isPending: false }),
  useDisconnectTeamDirectory: () => ({ mutateAsync: state.disconnect, isPending: false }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
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

beforeEach(() => {
  vi.resetAllMocks()
  state.data = { providers: [slack], directories: [] }
})
afterEach(cleanup)

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
})
