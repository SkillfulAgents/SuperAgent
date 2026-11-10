// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BrowserAccount } from '@renderer/hooks/use-browser-accounts'

const state = vi.hoisted(() => ({
  accounts: [] as BrowserAccount[],
  selectedId: undefined as string | undefined,
  navigate: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  forgetSessions: vi.fn(),
  requestMethod: vi.fn(),
  removeApp: vi.fn(),
  removeKey: vi.fn(),
}))

vi.mock('@renderer/hooks/use-browser-accounts', async (importOriginal) => ({
  BrowserAccountRequestError: (await importOriginal<typeof import('@renderer/hooks/use-browser-accounts')>()).BrowserAccountRequestError,
  useBrowserAccounts: () => ({ data: state.accounts, isLoading: false, error: null }),
  useGrantBrowserAccount: () => ({ mutateAsync: state.grant, isPending: false }),
  useRevokeBrowserAccount: () => ({ mutateAsync: state.revoke, isPending: false }),
  useRenameBrowserAccount: () => ({ mutateAsync: state.rename, isPending: false }),
  useDeleteBrowserAccount: () => ({ mutateAsync: state.remove, isPending: false }),
  useForgetBrowserAccountSessions: () => ({ mutateAsync: state.forgetSessions, isPending: false }),
  useRequestSignInMethod: () => ({ mutateAsync: state.requestMethod, isPending: false }),
  useRemoveAuthenticator: () => ({ mutateAsync: state.removeApp, isPending: false }),
  useRemovePasskey: () => ({ mutateAsync: state.removeKey, isPending: false }),
}))
const auth = vi.hoisted(() => ({ isAuthMode: false, usable: new Set<string>() }))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: auth.isAuthMode, rolesReady: true, canUseAgent: (slug: string) => !auth.isAuthMode || auth.usable.has(slug) }),
}))
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: [{ slug: 'a1', displaySlug: 'a1', name: 'Ada' }, { slug: 'b2', displaySlug: 'b2', name: 'Bo' }], isLoading: false, error: null }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate, useSearch: () => ({ login: state.selectedId }) }))
vi.mock('@renderer/components/settings/settings-page', () => ({ useHideSettingsHeader: () => {}, useFullWidthSettingsContent: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { BrowserAccountRequestError } = await import('@renderer/hooks/use-browser-accounts')
const { LoginsTab } = await import('./logins-tab')

function account(over: Partial<BrowserAccount> = {}): BrowserAccount {
  return {
    id: 'acc-1',
    site: 'github.com',
    username: 'octocat',
    label: null,
    origin: 'https://github.com',
    parts: ['password', 'text:workspace'],
    via: null,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    lastUsedAt: null,
    rejectedAt: null,
    agentSlugs: ['a1'],
    agents: [{ slug: 'a1', name: 'Ada' }],
    sessions: [],
    signInMethods: { authenticator: null, passkeys: [], requestedAt: null, unavailable: null },
    ...over,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  state.selectedId = undefined
  state.accounts = [
    account(),
    account({
      id: 'acc-2',
      site: 'medium.com',
      origin: 'https://medium.com',
      username: 'me@gmail.com',
      parts: [],
      via: { id: 'acc-g', site: 'google.com', username: 'me@gmail.com', label: null, providerName: 'Google' },
      agentSlugs: [],
      agents: [],
    }),
  ]
  auth.isAuthMode = false
  auth.usable = new Set()
})
afterEach(cleanup)

describe('Settings → Logins', () => {
  it('lists each saved login with what it holds and how many agents use it, never a value', () => {
    render(<LoginsTab />)
    const github = screen.getByTestId('login-row-acc-1')
    expect(within(github).getByText('octocat')).toBeInTheDocument()
    expect(github).toHaveTextContent('github.com')
    expect(github).toHaveTextContent('Password, workspace')
    expect(screen.getByTestId('login-row-agents-acc-1')).toHaveTextContent('1 agent')
    expect(screen.getByTestId('login-row-acc-2')).toHaveTextContent('Signs in with Google (me@gmail.com)')
    expect(screen.getByTestId('login-row-agents-acc-2')).toHaveTextContent('No agent')
  })

  it('shows a login the site rejected, in the list and opened', () => {
    state.accounts = [account({ rejectedAt: new Date(Date.now() - 5 * 60_000).toISOString() })]
    state.selectedId = 'acc-1'
    render(<LoginsTab />)
    expect(screen.getByTestId('login-rejected')).toHaveTextContent('An agent said the site rejected its password, 5m ago.')
  })

  it('shows where a signed-in session is saved, and forgets it', async () => {
    state.accounts = [account({ sessions: [{ browserType: 'chrome', capturedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }] })]
    state.selectedId = 'acc-1'
    state.forgetSessions.mockResolvedValue(undefined)
    render(<LoginsTab />)
    expect(screen.getByTestId('login-session')).toHaveTextContent('Chrome, saved 3h ago')
    await userEvent.click(screen.getByTestId('login-session-forget'))
    await waitFor(() => expect(state.forgetSessions).toHaveBeenCalledWith('acc-1'))
  })

  it('asks agents to add an authenticator app, and says when one found none to add', async () => {
    state.selectedId = 'acc-1'
    state.requestMethod.mockResolvedValue(undefined)
    render(<LoginsTab />)
    await userEvent.click(screen.getByTestId('login-authenticator-request'))
    await waitFor(() => expect(state.requestMethod).toHaveBeenCalledWith({ accountId: 'acc-1', requested: true }))
    cleanup()

    state.accounts = [account({ signInMethods: { authenticator: null, passkeys: [], requestedAt: null, unavailable: { at: new Date(Date.now() - 2 * 3_600_000).toISOString(), reason: 'Two-factor authentication is off.' } } })]
    render(<LoginsTab />)
    expect(screen.getByTestId('login-authenticator-unavailable')).toHaveTextContent('An agent found none it could add, 2h ago: Two-factor authentication is off.')
    expect(screen.getByTestId('login-authenticator-request')).toHaveAttribute('data-state', 'unchecked')
  })

  it('shows the authenticator app an agent added, and removes it from the vault', async () => {
    const addedAt = new Date(Date.now() - 3 * 86_400_000).toISOString()
    state.accounts = [account({ signInMethods: { authenticator: { addedAt, issuer: 'GitHub', accountName: 'octocat', name: 'Gamut', rejectedAt: null }, passkeys: [], requestedAt: null, unavailable: null } })]
    state.selectedId = 'acc-1'
    state.removeApp.mockResolvedValue(undefined)
    render(<LoginsTab />)
    expect(screen.getByTestId('login-authenticator-saved')).toHaveTextContent('Authenticator app, added by an agent 3d ago · named Gamut · GitHub')
    expect(screen.queryByTestId('login-authenticator-request')).toBeNull()
    await userEvent.click(screen.getByTestId('login-authenticator-remove'))
    await waitFor(() => expect(state.removeApp).toHaveBeenCalledWith('acc-1'))
  })

  it('shows the passkeys an agent added, and removes one from the vault', async () => {
    const addedAt = new Date(Date.now() - 2 * 86_400_000).toISOString()
    state.accounts = [account({ signInMethods: { authenticator: null, passkeys: [{ credentialId: 'Y3JlZC0x', rpId: 'github.com', addedAt, name: 'Gamut', userName: 'octocat' }], requestedAt: null, unavailable: null } })]
    state.selectedId = 'acc-1'
    state.removeKey.mockResolvedValue(undefined)
    render(<LoginsTab />)
    expect(screen.getByTestId('login-passkey-0')).toHaveTextContent('Passkey, added by an agent 2d ago · named Gamut · github.com')
    // It holds a method: no switch asking for one.
    expect(screen.queryByTestId('login-authenticator-request')).toBeNull()
    await userEvent.click(screen.getByTestId('login-passkey-remove-0'))
    await waitFor(() => expect(state.removeKey).toHaveBeenCalledWith({ accountId: 'acc-1', credentialId: 'Y3JlZC0x' }))
  })

  it('lists the authenticator app with what a login holds', () => {
    state.accounts = [account({ signInMethods: { authenticator: { addedAt: new Date().toISOString(), issuer: null, accountName: null, name: null, rejectedAt: null }, passkeys: [], requestedAt: null, unavailable: null } })]
    render(<LoginsTab />)
    expect(screen.getByTestId('login-row-acc-1')).toHaveTextContent('Password, workspace, authenticator app')
  })

  it('shows no session row for a login without one', () => {
    state.selectedId = 'acc-1'
    render(<LoginsTab />)
    expect(screen.queryByTestId('login-session')).toBeNull()
  })

  it('says how to get one when the vault is empty', () => {
    state.accounts = []
    render(<LoginsTab />)
    expect(screen.getByTestId('logins-empty')).toHaveTextContent('No saved logins yet')
  })

  it('deletes a login after a confirm that names it', async () => {
    state.remove.mockResolvedValue(undefined)
    render(<LoginsTab />)
    await userEvent.click(screen.getByTestId('login-row-delete-acc-1'))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Delete octocat on github.com?')
    expect(screen.getByRole('alertdialog')).toHaveTextContent('1 agent can no longer sign in with it')
    await userEvent.click(screen.getByTestId('login-delete-confirm'))
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('acc-1'))
  })

  it('opens a login with an agent switch for each agent, and turns them on and off', async () => {
    state.selectedId = 'acc-1'
    state.grant.mockResolvedValue(undefined)
    state.revoke.mockResolvedValue(undefined)
    render(<LoginsTab />)
    expect(screen.getByTestId('login-detail-saved')).toHaveTextContent('octocat')
    expect(screen.getByTestId('login-detail-saved')).toHaveTextContent('workspace')
    const ada = screen.getByTestId('login-agent-toggle-acc-1-a1')
    const bo = screen.getByTestId('login-agent-toggle-acc-1-b2')
    expect(ada).toBeChecked()
    expect(bo).not.toBeChecked()

    await userEvent.click(bo)
    await waitFor(() => expect(state.grant).toHaveBeenCalledWith({ agentSlug: 'b2', accountId: 'acc-1' }))
    await userEvent.click(screen.getByTestId('login-agent-toggle-acc-1-a1'))
    await waitFor(() => expect(state.revoke).toHaveBeenCalledWith({ agentSlug: 'a1', accountId: 'acc-1' }))
  })

  it('lets the owner turn off an agent they can no longer open', async () => {
    auth.isAuthMode = true
    auth.usable = new Set(['b2'])
    state.selectedId = 'acc-1'
    state.accounts = [account({ agentSlugs: ['gone'], agents: [{ slug: 'gone', name: 'Old Team Agent' }] })]
    state.revoke.mockResolvedValue(undefined)
    render(<LoginsTab />)
    // Ada is not theirs to use; the agent they lost access to is still listed, and on.
    expect(screen.queryByTestId('login-agent-toggle-acc-1-a1')).toBeNull()
    const gone = screen.getByTestId('login-agent-toggle-acc-1-gone')
    expect(gone).toBeChecked()
    await userEvent.click(gone)
    await waitFor(() => expect(state.revoke).toHaveBeenCalledWith({ agentSlug: 'gone', accountId: 'acc-1' }))
  })

  it('shares with an agent other members use only after the user confirms', async () => {
    state.selectedId = 'acc-1'
    state.grant
      .mockRejectedValueOnce(new BrowserAccountRequestError('Other members can sign in with this account.', 'shared_agent'))
      .mockResolvedValueOnce(undefined)
    render(<LoginsTab />)
    await userEvent.click(screen.getByTestId('login-agent-toggle-acc-1-b2'))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Share octocat with Bo?')
    await userEvent.click(screen.getByTestId('login-share-confirm'))
    await waitFor(() => expect(state.grant).toHaveBeenLastCalledWith({ agentSlug: 'b2', accountId: 'acc-1', sharedAgentAcknowledged: true }))
  })

  it('keeps an agent off when the user does not share', async () => {
    state.selectedId = 'acc-1'
    state.grant.mockRejectedValueOnce(new BrowserAccountRequestError('Other members can sign in with this account.', 'shared_agent'))
    render(<LoginsTab />)
    await userEvent.click(screen.getByTestId('login-agent-toggle-acc-1-b2'))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByTestId('login-agent-toggle-acc-1-b2')).not.toBeChecked())
    expect(state.grant).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent('octocat was not shared with Bo.')
  })
})
