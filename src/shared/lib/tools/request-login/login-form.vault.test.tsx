// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { onlineManager } from '@tanstack/react-query'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import { LoginRequestItem } from './request'
import { resetLoginRequestStore } from './login-request-store'
import type { LoginContext, LoginVaultInfo, LoginVaultPayload } from './login-request'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))
vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }))
// The password manager's picker has tests of its own.
vi.mock('../request-browser-input/browser-credential-picker', () => ({ BrowserCredentialPicker: () => null }))

const BASE = '/api/agents/my-agent/sessions/s-1'
const field = (kind: LoginContext['fields'][number]['kind'], label: string) =>
  ({ kind, label, inputType: kind === 'password' ? 'password' : 'text', inputMode: '', autocomplete: '', maxLength: -1 })
const CONTEXT: LoginContext = {
  origin: 'https://github.com',
  url: 'https://github.com/login',
  topOrigin: 'https://github.com',
  submit: true,
  fields: [field('username', 'Email'), field('password', 'Password')],
  held: [],
  providers: [],
}
const INFO: LoginVaultInfo = {
  site: 'github.com',
  otherMembers: 0,
  identity: null,
  accounts: [],
  providerAccounts: [],
  providers: [{ id: 'google', name: 'Google', site: 'google.com' }, { id: 'github', name: 'GitHub', site: 'github.com' }],
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: () => Promise.resolve(body) })
let context: LoginContext
let info: LoginVaultInfo

function posted(path: string): Record<string, unknown>[] {
  return mockApiFetch.mock.calls
    .filter(([url, init]) => url === `${BASE}${path}` && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
}

function renderCard(vault?: LoginVaultPayload) {
  return render(
    <LoginRequestItem
      toolUseId="tu-1"
      message="Sign in to GitHub so the agent can read settings."
      fields={context.fields.map(({ kind, label }) => ({ kind, label }))}
      vault={vault}
      sessionId="s-1"
      agentSlug="my-agent"
      onComplete={vi.fn()}
    />,
  )
}

/** The form once the browser located the fields and the vault answered: the fields. */
async function ready() {
  await screen.findByTestId('login-save-section')
}

/** The form once the browser located the fields and the vault answered: the choice among the saved accounts. */
async function choosing() {
  await screen.findByTestId('login-vault-accounts')
}

const offer = (over: Partial<LoginVaultInfo['accounts'][number]> = {}) =>
  ({ id: 'acc-1', username: 'octocat', label: null, parts: ['password'], via: null, granted: false, ...over })

describe('the sign-in form with the vault', () => {
  beforeEach(() => {
    resetLoginRequestStore()
    mockApiFetch.mockReset()
    context = CONTEXT
    info = INFO
    mockApiFetch.mockImplementation((url: string) => {
      if (url === `${BASE}/login-request?toolUseId=tu-1`) return Promise.resolve(json(200, context))
      if (url === `${BASE}/login-request/vault?toolUseId=tu-1`) return Promise.resolve(json(200, info))
      if (url === `${BASE}/fill-login`) return Promise.resolve(json(200, { success: true, filled: 2, failed: 0, submitted: true, problems: [] }))
      if (url === `${BASE}/login-via`) return Promise.resolve(json(200, { success: true, provider: { site: 'google.com', username: 'me@gmail.com' } }))
      return Promise.resolve(json(404, { error: `unrouted ${url}` }))
    })
  })

  it('saves what the user signs in with by default, naming the account', async () => {
    const user = userEvent.setup()
    renderCard()
    await ready()
    expect(screen.getByTestId('login-save')).toHaveAttribute('data-state', 'checked')
    await user.type(screen.getByTestId('login-field-0'), 'octocat')
    expect(screen.getByTestId('login-save-section')).toHaveTextContent('Saves octocat to your vault for github.com')
    await user.type(screen.getByTestId('login-field-1'), 'hunter2')
    await user.click(screen.getByTestId('login-submit'))

    await waitFor(() => expect(posted('/fill-login')).toHaveLength(1))
    expect(posted('/fill-login')[0]).toEqual({ toolUseId: 'tu-1', origin: 'https://github.com', values: ['octocat', 'hunter2'], save: true })
  })

  it('sends nothing to save once the user unchecks it', async () => {
    const user = userEvent.setup()
    renderCard()
    await ready()
    await user.click(screen.getByTestId('login-save'))
    await user.type(screen.getByTestId('login-field-0'), 'octocat')
    await user.type(screen.getByTestId('login-field-1'), 'hunter2')
    await user.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(posted('/fill-login')).toHaveLength(1))
    expect(posted('/fill-login')[0]).not.toHaveProperty('save')
  })

  it('on an agent other members use, saves only when the user chooses to, after saying so', async () => {
    const user = userEvent.setup()
    info = { ...INFO, otherMembers: 2 }
    renderCard()
    await ready()
    expect(screen.getByTestId('login-save')).toHaveAttribute('data-state', 'unchecked')
    expect(screen.queryByTestId('login-shared-notice')).toBeNull()
    await user.click(screen.getByTestId('login-save'))
    expect(screen.getByTestId('login-shared-notice')).toHaveTextContent('2 other people can use this agent. They will be able to have it sign in to github.com as you.')
    await user.type(screen.getByTestId('login-field-0'), 'octocat')
    await user.type(screen.getByTestId('login-field-1'), 'hunter2')
    await user.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(posted('/fill-login')).toHaveLength(1))
    expect(posted('/fill-login')[0]).toMatchObject({ save: true, sharedAgentAcknowledged: true })
  })

  it('signs in with a saved account in one click when it fills every field', async () => {
    const user = userEvent.setup()
    info = { ...INFO, accounts: [offer()] }
    renderCard()
    await choosing()
    expect(within(screen.getByTestId('login-vault-accounts')).getByText('Saved: password')).toBeInTheDocument()
    await user.click(screen.getByTestId('login-vault-account-acc-1'))
    await waitFor(() => expect(posted('/fill-login')).toHaveLength(1))
    expect(posted('/fill-login')[0]).toEqual({ toolUseId: 'tu-1', origin: 'https://github.com', values: ['', ''], accountId: 'acc-1' })
  })

  it('shows only the saved accounts first, and the fields for a different account', async () => {
    const user = userEvent.setup()
    context = { ...CONTEXT, providers: ['google'] }
    info = { ...INFO, accounts: [offer(), offer({ id: 'acc-2', username: 'hubot' })] }
    renderCard()
    await choosing()
    const chooser = screen.getByTestId('login-vault-accounts')
    expect(within(chooser).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'octocatSaved: passwordUse', 'hubotSaved: passwordUse', 'Use a different account',
    ])
    // Nothing else until the user goes on: no fields, saving, providers or other ways in.
    for (const id of ['login-form', 'login-save-section', 'login-via-providers', 'login-take-over', 'login-submit']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
    expect(screen.getByTestId('login-decline')).toBeInTheDocument()

    await user.click(screen.getByTestId('login-different-account'))
    expect(screen.queryByTestId('login-vault-accounts')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('login-field-0')).toHaveFocus())
    expect(screen.getByTestId('login-save-section')).toBeInTheDocument()
    expect(screen.getByTestId('login-via-providers')).toBeInTheDocument()
    await user.type(screen.getByTestId('login-field-0'), 'monalisa')

    // Back to the saved accounts, and on again: what was typed is still there.
    await user.click(screen.getByTestId('login-back-to-accounts'))
    expect(screen.getByTestId('login-vault-accounts')).toBeInTheDocument()
    await user.click(screen.getByTestId('login-different-account'))
    expect(screen.getByTestId('login-field-0')).toHaveValue('monalisa')
    await user.type(screen.getByTestId('login-field-1'), 'hunter2')
    await user.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(posted('/fill-login')).toHaveLength(1))
    expect(posted('/fill-login')[0]).toEqual({ toolUseId: 'tu-1', origin: 'https://github.com', values: ['monalisa', 'hunter2'], save: true })
  })

  it('opens a retry on the fields, with the saved accounts a click away', async () => {
    info = { ...INFO, accounts: [offer({ rejected: true })] }
    renderCard({ mode: 'ask', username: 'octocat', reason: 'The page says "Incorrect password."' })
    await ready()
    await waitFor(() => expect(screen.getByTestId('login-field-0')).toHaveValue('octocat'))
    expect(screen.queryByTestId('login-vault-accounts')).toBeNull()
    expect(screen.getByTestId('login-retry-note')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByTestId('login-back-to-accounts'))
    expect(screen.getByTestId('login-vault-accounts')).toHaveTextContent('the site turned it down')
  })

  it('gets past the wait with the network down: the saved accounts come from this app', async () => {
    onlineManager.setOnline(false)
    try {
      renderCard()
      await ready()
    } finally {
      onlineManager.setOnline(true)
    }
  })

  it('opens on the fields for the account the agent named, prefilled, with the saved accounts a click away', async () => {
    info = { ...INFO, accounts: [offer(), offer({ id: 'acc-2', username: 'hubot' })] }
    renderCard({ mode: 'ask', username: 'monalisa' })
    await ready()
    await waitFor(() => expect(screen.getByTestId('login-field-0')).toHaveValue('monalisa'))
    expect(screen.queryByTestId('login-vault-accounts')).toBeNull()
    expect(screen.getByTestId('login-back-to-accounts')).toBeInTheDocument()
  })

  it('opens a code step on its field: no saved account fills a code', async () => {
    context = { ...CONTEXT, fields: [field('otp', 'Verification code')] }
    info = { ...INFO, accounts: [offer(), offer({ id: 'acc-2', username: 'hubot', parts: [], via: { id: 'acc-g', site: 'google.com', username: 'me@gmail.com', name: 'Google' } })] }
    renderCard()
    await screen.findByTestId('login-form')
    await waitFor(() => expect(screen.getByTestId('login-field-0')).not.toBeDisabled())
    expect(screen.queryByTestId('login-vault-accounts')).toBeNull()
    expect(screen.queryByTestId('login-back-to-accounts')).toBeNull()
  })

  it('offers on a page of provider buttons only the saved accounts that sign in through one', async () => {
    context = { ...CONTEXT, fields: [], submit: false, providers: ['google'] }
    info = { ...INFO, accounts: [offer(), offer({ id: 'acc-2', username: 'hubot', parts: [], via: { id: 'acc-g', site: 'google.com', username: 'me@gmail.com', name: 'Google' } })] }
    renderCard()
    await choosing()
    expect(screen.queryByTestId('login-vault-account-acc-1')).toBeNull()
    expect(screen.getByTestId('login-vault-account-acc-2')).toBeInTheDocument()
  })

  it('forgets what one saved account could not fill once the user picks another', async () => {
    const user = userEvent.setup()
    context = { ...CONTEXT, fields: [field('username', 'Email'), field('password', 'Password'), field('text', 'Workspace')] }
    info = { ...INFO, accounts: [offer({ parts: ['password', 'text:workspace'] }), offer({ id: 'acc-2', username: 'hubot', parts: ['password'] })] }
    mockApiFetch.mockImplementation((url: string) => {
      if (url === `${BASE}/login-request?toolUseId=tu-1`) return Promise.resolve(json(200, context))
      if (url === `${BASE}/login-request/vault?toolUseId=tu-1`) return Promise.resolve(json(200, info))
      if (url === `${BASE}/fill-login`) return Promise.resolve(json(409, { error: 'Enter what the saved account could not fill.', reason: 'fields_needed', fields: [1, 2] }))
      return Promise.resolve(json(404, { error: `unrouted ${url}` }))
    })
    renderCard()
    await choosing()
    await user.click(screen.getByTestId('login-vault-account-acc-1'))
    await screen.findByTestId('login-error')
    expect(screen.getByTestId('login-field-1')).toBeInTheDocument()
    await user.click(screen.getByTestId('login-vault-account-clear'))
    await choosing()
    await user.click(screen.getByTestId('login-vault-account-acc-2'))
    // Its own password is saved: only the workspace is asked for.
    expect(screen.getByTestId('login-vault-account')).toHaveTextContent('Signing in as hubot')
    expect(screen.queryByTestId('login-field-1')).toBeNull()
    expect(screen.getByTestId('login-field-2')).toBeInTheDocument()
  })

  it('asks for just what a one-click account turns out to lack, as that account', async () => {
    const user = userEvent.setup()
    info = { ...INFO, accounts: [offer()] }
    let fills = 0
    mockApiFetch.mockImplementation((url: string) => {
      if (url === `${BASE}/login-request?toolUseId=tu-1`) return Promise.resolve(json(200, context))
      if (url === `${BASE}/login-request/vault?toolUseId=tu-1`) return Promise.resolve(json(200, info))
      if (url === `${BASE}/fill-login`) {
        return Promise.resolve(++fills === 1
          ? json(409, { error: 'The saved account does not have a value for Password.', reason: 'fields_needed', fields: [1] })
          : json(200, { success: true, filled: 2, failed: 0, submitted: true, problems: [] }))
      }
      return Promise.resolve(json(404, { error: `unrouted ${url}` }))
    })
    renderCard()
    await choosing()
    await user.click(screen.getByTestId('login-vault-account-acc-1'))
    await screen.findByTestId('login-error')
    expect(screen.getByTestId('login-vault-account')).toHaveTextContent('Signing in as octocat')
    expect(screen.queryByTestId('login-field-0')).toBeNull()
    await user.type(screen.getByTestId('login-field-1'), 'hunter2')
    await user.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(posted('/fill-login')).toHaveLength(2))
    expect(posted('/fill-login')[1]).toMatchObject({ values: ['', 'hunter2'], accountId: 'acc-1' })
  })

  it('goes on to the fields, with the accounts read again, when a saved account is gone', async () => {
    const user = userEvent.setup()
    info = { ...INFO, accounts: [offer()] }
    mockApiFetch.mockImplementation((url: string) => {
      if (url === `${BASE}/login-request?toolUseId=tu-1`) return Promise.resolve(json(200, context))
      if (url === `${BASE}/login-request/vault?toolUseId=tu-1`) return Promise.resolve(json(200, info))
      if (url === `${BASE}/fill-login`) return Promise.resolve(json(409, { error: 'That saved account is no longer available.', reason: 'account_unavailable' }))
      return Promise.resolve(json(404, { error: `unrouted ${url}` }))
    })
    renderCard()
    await choosing()
    info = { ...INFO, accounts: [] }
    await user.click(screen.getByTestId('login-vault-account-acc-1'))
    await screen.findByTestId('login-form')
    expect(screen.getByTestId('login-error')).toHaveTextContent('no longer available')
    // The vault no longer lists it: no way back to it.
    await waitFor(() => expect(screen.queryByTestId('login-back-to-accounts')).toBeNull())
  })

  it('asks for the password of a saved account the vault may not fill into this plain-HTTP page', async () => {
    const user = userEvent.setup()
    info = { ...INFO, accounts: [offer({ fillsHere: false })] }
    renderCard()
    await choosing()
    await user.click(screen.getByTestId('login-vault-account-acc-1'))
    // Not sent at once: the password field stays for the user.
    expect(posted('/fill-login')).toEqual([])
    expect(screen.queryByTestId('login-field-0')).toBeNull()
    await user.type(screen.getByTestId('login-field-1'), 'hunter2')
    await user.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(posted('/fill-login')).toHaveLength(1))
    expect(posted('/fill-login')[0]).toMatchObject({ values: ['', 'hunter2'], accountId: 'acc-1' })
  })

  it('answers with the provider account when the saved account signs in through one', async () => {
    const user = userEvent.setup()
    info = { ...INFO, accounts: [offer({ parts: [], via: { id: 'acc-g', site: 'google.com', username: 'me@gmail.com', name: 'Google' } })] }
    renderCard()
    await choosing()
    expect(screen.getByTestId('login-vault-accounts')).toHaveTextContent('Signs in with Google (me@gmail.com)')
    await user.click(screen.getByTestId('login-vault-account-acc-1'))
    await waitFor(() => expect(posted('/login-via')).toHaveLength(1))
    expect(posted('/login-via')[0]).toEqual({ toolUseId: 'tu-1', origin: 'https://github.com', provider: { accountId: 'acc-g' }, sharedAgentAcknowledged: false })
    expect(posted('/fill-login')).toEqual([])
  })

  it('picks a saved account that lacks a part, and asks only for that part', async () => {
    const user = userEvent.setup()
    info = { ...INFO, accounts: [offer({ parts: [] })] }
    renderCard()
    await choosing()
    await user.click(screen.getByTestId('login-vault-account-acc-1'))
    expect(screen.getByTestId('login-vault-account')).toHaveTextContent('Signing in as octocat')
    // The field it asks for takes the focus.
    await waitFor(() => expect(screen.getByTestId('login-field-1')).toHaveFocus())
    expect(screen.queryByTestId('login-field-0')).toBeNull()
    await user.type(screen.getByTestId('login-field-1'), 'hunter2')
    await user.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(posted('/fill-login')).toHaveLength(1))
    // The new password is saved into that account.
    expect(posted('/fill-login')[0]).toEqual({ toolUseId: 'tu-1', origin: 'https://github.com', values: ['', 'hunter2'], save: true, accountId: 'acc-1' })
  })

  it('asks only for what the account the agent named lacks', async () => {
    const user = userEvent.setup()
    renderCard({ mode: 'complete', username: 'octocat', accountId: 'acc-9', covered: [0] })
    await ready()
    expect(screen.getByTestId('login-vault-account')).toHaveTextContent('Signing in as octocat')
    expect(screen.queryByTestId('login-field-0')).toBeNull()
    expect(screen.queryByTestId('login-vault-accounts')).toBeNull()
    // The first field shown is a password: it takes the focus.
    await waitFor(() => expect(screen.getByTestId('login-field-1')).toHaveFocus())
    await user.type(screen.getByTestId('login-field-1'), 'hunter2')
    await user.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(posted('/fill-login')).toHaveLength(1))
    expect(posted('/fill-login')[0]).toMatchObject({ values: ['', 'hunter2'], accountId: 'acc-9' })
  })

  it('offers nothing to save on a step that only asks for a code', async () => {
    const user = userEvent.setup()
    context = { ...CONTEXT, fields: [field('otp', 'Verification code')] }
    renderCard({ mode: 'complete', username: 'octocat', accountId: 'acc-9', covered: [] })
    await screen.findByTestId('login-vault-account')
    await waitFor(() => expect(screen.getByTestId('login-field-0')).not.toBeDisabled())
    expect(screen.queryByTestId('login-save-section')).toBeNull()
    await user.type(screen.getByTestId('login-field-0'), '246810')
    await user.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(posted('/fill-login')).toHaveLength(1))
    expect(posted('/fill-login')[0]).toEqual({ toolUseId: 'tu-1', origin: 'https://github.com', values: ['246810'], accountId: 'acc-9' })
  })

  it('prefills the account the agent asked the user to correct', async () => {
    renderCard({ mode: 'ask', username: 'octocat' })
    await ready()
    await waitFor(() => expect(screen.getByTestId('login-field-0')).toHaveValue('octocat'))
    expect(screen.queryByTestId('login-retry-note')).toBeNull()
  })

  it('says why the agent asks again: its own words beneath, or that the site turned the saved password down', async () => {
    renderCard({ mode: 'ask', username: 'octocat', reason: 'The page says "Incorrect password."' })
    await ready()
    const note = screen.getByTestId('login-retry-note')
    expect(note).toHaveTextContent('The agent says the sign-in did not go through:')
    expect(note.querySelector('span')).toHaveTextContent(/^The page says "Incorrect password."$/)
  })

  it('says when the site turned the saved password down', async () => {
    renderCard({ mode: 'ask', username: 'octocat', rejectedAt: '2026-10-23T12:00:00.000Z' })
    await ready()
    expect(screen.getByTestId('login-retry-note')).toHaveTextContent('The site turned down the saved password for octocat on')
  })

  it('asks for the next step\'s field now, and sends it apart from the page\'s', async () => {
    const user = userEvent.setup()
    context = { ...CONTEXT, fields: [field('username', 'Email')], held: [{ kind: 'password', label: 'Password' }] }
    renderCard()
    await ready()
    expect(screen.getByTestId('login-held')).toHaveTextContent('For the next step')
    // The next step's password is as hidden from the agent as one on this page.
    expect(screen.getByTestId('login-privacy')).toHaveTextContent('The agent never sees the password; it can see the username.')
    await user.type(screen.getByTestId('login-field-0'), 'octocat')
    await user.type(screen.getByTestId('login-held-field-0'), 'next-pw')
    expect(screen.getByTestId('login-submit')).toHaveTextContent('Continue')
    await user.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(posted('/fill-login')).toHaveLength(1))
    expect(posted('/fill-login')[0]).toEqual({ toolUseId: 'tu-1', origin: 'https://github.com', values: ['octocat'], heldValues: ['next-pw'], save: true })
  })

  it('asks whose account it is to save one from a page without a username field', async () => {
    const user = userEvent.setup()
    context = { ...CONTEXT, fields: [field('password', 'Password')] }
    renderCard()
    await ready()
    await user.type(screen.getByTestId('login-field-0'), 'hunter2')
    expect(screen.getByTestId('login-submit')).toBeDisabled()
    await user.type(screen.getByTestId('login-save-username'), 'octocat')
    await user.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(posted('/fill-login')).toHaveLength(1))
    expect(posted('/fill-login')[0]).toMatchObject({ values: ['hunter2'], save: true, username: 'octocat' })
  })

  it('knows whose account it is from the previous step', async () => {
    context = { ...CONTEXT, fields: [field('password', 'Password')] }
    info = { ...INFO, identity: 'octocat' }
    renderCard()
    await ready()
    expect(screen.queryByTestId('login-save-username')).toBeNull()
    expect(screen.getByTestId('login-save-section')).toHaveTextContent('Saves octocat')
  })

  it('signs in through a provider: one of its saved accounts', async () => {
    const user = userEvent.setup()
    context = { ...CONTEXT, providers: ['google'] }
    info = { ...INFO, providerAccounts: [{ ...offer({ id: 'acc-g', username: 'me@gmail.com', parts: [] }), site: 'accounts.google.com', providerName: 'Google', providerId: 'google' }] }
    renderCard()
    await ready()
    await user.click(screen.getByTestId('login-via-provider-google'))
    expect(screen.getByTestId('login-via')).toHaveTextContent('Which Google account do you sign in to github.com with?')
    await user.click(screen.getByTestId('login-via-account-acc-g'))
    await waitFor(() => expect(posted('/login-via')).toHaveLength(1))
    expect(posted('/login-via')[0]).toEqual({ toolUseId: 'tu-1', origin: 'https://github.com', provider: { accountId: 'acc-g' }, sharedAgentAcknowledged: false })
    await waitFor(() => expect(screen.getByTestId('login-request-completed')).toHaveAttribute('data-status', 'via'))
  })

  it('names the account at the provider picked', async () => {
    const user = userEvent.setup()
    context = { ...CONTEXT, providers: ['google'] }
    renderCard()
    await ready()
    await user.click(screen.getByTestId('login-via-provider-google'))
    expect(screen.getByTestId('login-via-submit')).toBeDisabled()
    await user.type(screen.getByTestId('login-via-username'), 'me@gmail.com')
    await user.click(screen.getByTestId('login-via-submit'))
    await waitFor(() => expect(posted('/login-via')).toHaveLength(1))
    expect(posted('/login-via')[0]).toMatchObject({ provider: { providerId: 'google', username: 'me@gmail.com' } })
  })

  const provider = (id: string, name: string, site: string) => ({ id, name, site })
  const PROVIDERS = [provider('google', 'Google', 'google.com'), provider('microsoft', 'Microsoft', 'live.com'), provider('apple', 'Apple', 'apple.com'),
    provider('github', 'GitHub', 'github.com'), provider('facebook', 'Facebook', 'facebook.com'), provider('slack', 'Slack', 'slack.com')]

  it("shows the page's own provider buttons in its order, the rest under More", async () => {
    const user = userEvent.setup()
    // GitHub is the site itself; "okta" is no provider the form knows.
    context = { ...CONTEXT, providers: ['slack', 'github', 'okta', 'google'] }
    info = {
      ...INFO,
      providers: PROVIDERS,
      providerAccounts: [
        { ...offer({ id: 'acc-s', username: 'me@work.test', parts: [] }), site: 'slack.com', providerName: 'Slack', providerId: 'slack' },
        { ...offer({ id: 'acc-o', username: 'me@corp.test', parts: ['password'] }), site: 'acme.okta.com', providerName: 'acme.okta.com', providerId: null },
      ],
    }
    renderCard()
    await ready()
    const row = screen.getByTestId('login-via-providers')
    expect(row).toHaveTextContent('Or sign in with')
    expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual(['Slack', 'Google', 'More'])
    await user.click(screen.getByTestId('login-via-more'))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Microsoft', 'Apple', 'Facebook', 'Another saved account'])
    await user.click(screen.getByRole('menuitem', { name: 'Another saved account' }))
    expect(screen.getByTestId('login-via')).toHaveTextContent('Which account do you sign in to github.com with?')
    expect(screen.queryByTestId('login-via-account-acc-s')).toBeNull()
    expect(screen.queryByTestId('login-via-username')).toBeNull()
    await user.click(screen.getByTestId('login-via-account-acc-o'))
    await waitFor(() => expect(posted('/login-via')).toHaveLength(1))
    expect(posted('/login-via')[0]).toMatchObject({ provider: { accountId: 'acc-o' } })
  })

  it('keeps every provider out of the way when the page shows none', async () => {
    const user = userEvent.setup()
    info = { ...INFO, providers: PROVIDERS }
    renderCard()
    await ready()
    expect(screen.queryByTestId('login-via-providers')).toBeNull()
    expect(screen.getByTestId('login-via-more')).toHaveTextContent('Other ways to sign in')
    await user.click(screen.getByTestId('login-via-more'))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Google', 'Microsoft', 'Apple', 'Facebook', 'Slack'])
    await user.click(screen.getByRole('menuitem', { name: 'Google' }))
    expect(screen.getByTestId('login-via')).toHaveTextContent('Which Google account do you sign in to github.com with?')
  })

  it("offers the page's providers on a page without fields", async () => {
    context = { ...CONTEXT, fields: [], submit: false, providers: ['google'] }
    renderCard()
    expect(await screen.findByTestId('login-via-providers')).toHaveTextContent(/^Sign in with/)
    expect(screen.queryByTestId('login-submit')).toBeNull()
    expect(screen.queryByTestId('login-save-section')).toBeNull()
  })
})
