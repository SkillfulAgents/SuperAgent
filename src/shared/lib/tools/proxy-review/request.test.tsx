// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProxyReviewRequestItem } from './request'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouter: () => ({ state: { location: { pathname: '/agents/my-agent/sessions/s1', searchStr: '' } } }),
}))

let mockAccounts: unknown[] = []
let mockMcps: unknown[] = []
vi.mock('@renderer/hooks/use-connected-accounts', () => ({
  useAgentConnectedAccounts: () => ({ data: { accounts: mockAccounts } }),
}))
vi.mock('@renderer/hooks/use-remote-mcps', () => ({
  useAgentRemoteMcps: () => ({ data: { mcps: mockMcps } }),
}))

let mockDirty = false
const mockSave = vi.fn(async () => true)
type MockActions = (a: { isDirty: boolean; saving: boolean; save: () => Promise<boolean> }) => React.ReactNode
vi.mock('@renderer/components/settings/scope-policy-editor', () => ({
  scopeGroupTitle: () => 'Write/Delete actions',
  ScopePolicyEditorBody: ({ accountId, renderActions }: { accountId: string; renderActions: MockActions }) => (
    <div data-testid="scope-policy-section" data-account={accountId}>
      {renderActions({ isDirty: mockDirty, saving: false, save: mockSave })}
    </div>
  ),
}))

const mockToastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }))

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

function renderCard(props: Partial<React.ComponentProps<typeof ProxyReviewRequestItem>> = {}) {
  return render(
    <ProxyReviewRequestItem
      reviewId="review-1"
      agentSlug="my-agent"
      accountId="acct-or-mcp"
      toolkit="Railway"
      method="POST"
      targetPath="subscriptions/listen"
      matchedScopes={[]}
      scopeDescriptions={{}}
      onComplete={vi.fn()}
      {...props}
    />,
  )
}

async function chooseAlwaysAllowAll() {
  const user = userEvent.setup()
  await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
  await user.click(await screen.findByTestId('proxy-review-always-allow-all'))
}

function sentBody(): Record<string, unknown> {
  expect(mockApiFetch).toHaveBeenCalledOnce()
  const [url, init] = mockApiFetch.mock.calls[0] as [string, RequestInit]
  expect(url).toBe('/api/agents/my-agent/proxy-review/review-1/always')
  return JSON.parse(init.body as string)
}

describe('ProxyReviewRequestItem title', () => {
  it('renders the endpoint description as inline Markdown', () => {
    renderCard({
      displayText: 'Allow sends the specified message to the recipients in the `To`, `Cc`, and `Bcc` headers. For example usage, see [Sending email](https://developers.google.com/workspace/gmail/api/guides/sending)?',
    })
    const link = screen.getByRole('link', { name: 'Sending email' })
    expect(link.getAttribute('href')).toBe('https://developers.google.com/workspace/gmail/api/guides/sending')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.getByText('To').tagName).toBe('CODE')
    expect(document.body.textContent).not.toContain('](')
    expect(document.body.textContent).not.toContain('`')
  })
})

describe('ProxyReviewRequestItem "always" policy routing', () => {
  beforeEach(() => {
    mockAccounts = []
    mockApiFetch.mockReset()
    mockApiFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
  })

  // Regression: Railway's MCP server sent `subscriptions/listen`, which is not
  // a tools/call, so the review's path carried no "tools/call" prefix. The
  // card inferred "api" from the path and the server then tried to write the
  // MCP server id into apiScopePolicies → "FOREIGN KEY constraint failed".
  it('sends the stamped mcp type even when the path does not look like a tool call', async () => {
    renderCard({ reviewType: 'mcp' })
    await chooseAlwaysAllowAll()

    expect(sentBody()).toMatchObject({ decision: 'allow', scope: '*', accountId: 'acct-or-mcp', reviewType: 'mcp' })
    await waitFor(() => expect(screen.getByTestId('proxy-review-completed')).toBeInTheDocument())
  })

  it.each([
    { case: 'a stamped api review whose path looks like a tool call', reviewType: 'api' as const, targetPath: 'tools/call: something' },
    { case: 'an unstamped review with an API path', reviewType: undefined, targetPath: 'gmail/v1/users/me/messages' },
  ])('offers no MCP "always" options for $case', async ({ reviewType, targetPath }) => {
    renderCard({ reviewType, targetPath })
    await userEvent.setup().click(screen.getByTestId('proxy-review-always-allow-btn'))

    expect(await screen.findByTestId('proxy-review-allow-once-menu-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('proxy-review-always-allow-all')).not.toBeInTheDocument()
  })

  it('falls back to the path prefix for an unstamped MCP review', async () => {
    renderCard({ targetPath: 'tools/call: list_issues' })
    await chooseAlwaysAllowAll()

    expect(sentBody()).toMatchObject({ reviewType: 'mcp' })
  })

  it('shows the server error inline and stays pending when the policy did not save', async () => {
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'MCP server no longer exists; the policy was not saved' }), { status: 400 }),
    )
    renderCard({ reviewType: 'mcp' })
    await chooseAlwaysAllowAll()

    expect(await screen.findByText(/MCP server no longer exists/)).toBeInTheDocument()
    expect(screen.getByTestId('proxy-review-request')).toBeInTheDocument()
    expect(screen.queryByTestId('proxy-review-completed')).not.toBeInTheDocument()
  })
})

describe('ProxyReviewRequestItem request body', () => {
  const body = 'mutation { issueDelete(id: "LIN-1") { success } }'

  it('opens what the call sends when the headline cannot name the call, and folds it when it can', () => {
    const { unmount } = renderCard({ toolkit: 'linear', targetPath: 'graphql', requestBody: body })
    expect(screen.getByTestId('proxy-review-body')).toHaveTextContent(body)
    unmount()
    renderCard({ toolkit: 'gmail', targetPath: 'gmail/v1/users/me/messages/send', requestBody: '{}', endpointDescription: 'Send an email' })
    expect(screen.queryByTestId('proxy-review-body')).toBeNull()
  })

  it('keeps per-tool policies on an MCP card, which never carries an endpoint description', async () => {
    const user = userEvent.setup()
    renderCard({ reviewType: 'mcp', matchedScopes: ['create_issue'] })
    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    expect(await screen.findByTestId('proxy-review-specific-scope-toggle')).toBeInTheDocument()
  })

  it('opens a folded body on click, and has nothing to open without one', async () => {
    const user = userEvent.setup()
    const { unmount } = renderCard({ requestBody: '{"to":"a@b.co"}', endpointDescription: 'Send an email' })
    await user.click(screen.getByTestId('proxy-review-body-toggle'))
    expect(screen.getByTestId('proxy-review-body')).toHaveTextContent('a@b.co')
    unmount()
    renderCard({})
    expect(screen.queryByTestId('proxy-review-body-toggle')).toBeNull()
  })
})

describe('ProxyReviewRequestItem permissions in the Allow menu', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
    mockApiFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    mockSave.mockReset()
    mockToastError.mockReset()
    mockSave.mockResolvedValue(true)
    mockDirty = false
    mockAccounts = [{ id: 'acct-or-mcp' }]
  })

  async function openAllowMenu() {
    renderCard({ reviewType: 'api', toolkit: 'slack' })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    await screen.findByTestId('scope-policy-section')
    return user
  }

  const decisionCalls = () =>
    mockApiFetch.mock.calls.filter(([url]) => url === '/api/agents/my-agent/proxy-review/review-1')

  it('allows once from the permissions footer when nothing changed', async () => {
    const user = await openAllowMenu()

    expect(screen.getByTestId('scope-policy-section')).toHaveAttribute('data-account', 'acct-or-mcp')
    expect(screen.getAllByTestId('proxy-review-allow-once-menu-btn')).toHaveLength(1)
    expect(screen.queryByTestId('proxy-review-save-permissions')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Allow Once' }))

    expect(mockSave).not.toHaveBeenCalled()
    await waitFor(() => expect(decisionCalls()).toHaveLength(1))
  })

  it('allows only after the save settles, with Deny held off meanwhile', async () => {
    mockDirty = true
    let finishSave: (ok: boolean) => void = () => {}
    mockSave.mockReturnValue(new Promise<boolean>((resolve) => { finishSave = resolve }))
    const user = await openAllowMenu()
    await user.click(screen.getByRole('button', { name: 'Save & Allow' }))

    expect(decisionCalls()).toHaveLength(0)
    expect(screen.getByTestId('proxy-review-deny-btn')).toBeDisabled()
    finishSave(true)
    await waitFor(() => expect(decisionCalls()).toHaveLength(1))
  })

  it('does not allow when the save fails', async () => {
    mockDirty = true
    mockSave.mockResolvedValue(false)
    const user = await openAllowMenu()
    await user.click(screen.getByRole('button', { name: 'Save & Allow' }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Failed to save permissions'))
    expect(screen.getByTestId('proxy-review-deny-btn')).toBeEnabled()
    expect(decisionCalls()).toHaveLength(0)
  })

  it('saves without answering the card with Save', async () => {
    mockDirty = true
    const user = await openAllowMenu()
    await user.click(screen.getByTestId('proxy-review-save-permissions'))

    expect(mockSave).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByTestId('scope-policy-section')).not.toBeInTheDocument())
    expect(decisionCalls()).toHaveLength(0)
    expect(screen.getByTestId('proxy-review-request')).toBeInTheDocument()
  })

  it('keeps the MCP Always deny options on a card a require rule held', async () => {
    mockMcps = [{ id: 'acct-or-mcp', name: 'Linear' }]
    renderCard({
      reviewType: 'mcp',
      matchedScopes: ['search'],
      ruleOutcomes: [{ ruleId: 'r1', version: 1, effect: 'require', restatement: 'Ask first', result: 'false' }],
    })
    await userEvent.setup().click(screen.getByTestId('proxy-review-deny-btn-chevron'))

    expect(await screen.findByTestId('proxy-review-always-deny-search')).toBeInTheDocument()
  })

  it('shows a failed plain Save in the menu without answering the card', async () => {
    mockDirty = true
    mockSave.mockResolvedValue(false)
    const user = await openAllowMenu()
    await user.click(screen.getByTestId('proxy-review-save-permissions'))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Failed to save permissions'))
    expect(decisionCalls()).toHaveLength(0)
  })

  it('offers Allow Once and the settings link, not the editor, when a require rule held the request', async () => {
    renderCard({
      reviewType: 'api',
      toolkit: 'slack',
      ruleOutcomes: [{ ruleId: 'r1', version: 1, effect: 'require', name: 'External sends', restatement: 'Ask before external sends', result: 'false' }],
    })
    await userEvent.setup().click(screen.getByTestId('proxy-review-always-allow-btn'))

    expect(await screen.findByTestId('proxy-review-allow-once-menu-btn')).toBeInTheDocument()
    expect(screen.getByTestId('proxy-review-held-by-rule-note')).toBeInTheDocument()
    expect(screen.getByTestId('proxy-review-edit-permissions')).toBeInTheDocument()
    expect(screen.queryByTestId('scope-policy-section')).not.toBeInTheDocument()
  })

  it('offers only Allow once for an API account another member owns', async () => {
    mockAccounts = [{ kind: 'connected-account', toolkitSlug: 'slack', mappingId: 'm1' }]
    renderCard({ reviewType: 'api', toolkit: 'slack' })
    await userEvent.setup().click(screen.getByTestId('proxy-review-always-allow-btn'))

    expect(await screen.findByTestId('proxy-review-allow-once-menu-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('scope-policy-section')).not.toBeInTheDocument()
  })
})

describe('ProxyReviewRequestItem connection link', () => {
  beforeEach(() => {
    mockNavigate.mockReset()
    mockAccounts = []
    mockMcps = []
  })

  it.each([
    { reviewType: 'api' as const, detail: 'account-acct-or-mcp' },
    { reviewType: 'mcp' as const, detail: 'mcp-acct-or-mcp' },
  ])('opens the $reviewType connection page and returns to the card', async ({ reviewType, detail }) => {
    mockAccounts = [{ id: 'acct-or-mcp' }]
    mockMcps = [{ id: 'acct-or-mcp' }]
    renderCard({ reviewType })
    await userEvent.setup().click(screen.getByTestId('proxy-review-connection-link'))

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/agents/$slug/connections',
      params: { slug: 'my-agent' },
      search: { detail, source: 'home', from: '/agents/my-agent/sessions/s1' },
    })
  })

  it('opens the connection page from the header gear and the Allow menu', async () => {
    mockAccounts = [{ id: 'acct-or-mcp' }]
    renderCard({ reviewType: 'api' })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('proxy-review-permissions-btn'))
    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    await user.click(await screen.findByTestId('proxy-review-edit-permissions'))

    expect(mockNavigate).toHaveBeenCalledTimes(2)
    for (const [arg] of mockNavigate.mock.calls) {
      expect(arg).toMatchObject({ search: { detail: 'account-acct-or-mcp' } })
    }
  })

  it('links the toolkit name on the answered card', async () => {
    mockApiFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    mockAccounts = [{ id: 'acct-or-mcp' }]
    renderCard({ reviewType: 'api' })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    await user.click(await screen.findByTestId('proxy-review-allow-once-menu-btn'))
    await screen.findByTestId('proxy-review-completed')
    await user.click(screen.getByTestId('proxy-review-connection-link'))

    expect(mockNavigate).toHaveBeenCalledWith(expect.objectContaining({ search: expect.objectContaining({ detail: 'account-acct-or-mcp' }) }))
  })

  it('links the toolkit name on a read-only card too', () => {
    mockAccounts = [{ id: 'acct-or-mcp' }]
    renderCard({ reviewType: 'api', readOnly: true })

    expect(screen.getByTestId('proxy-review-connection-link')).toHaveTextContent('Railway')
  })

  it.each([
    { case: 'another member owns', accounts: [{ kind: 'connected-account', toolkitSlug: 'railway', mappingId: 'm1' }] },
    { case: 'is no longer on the agent', accounts: [{ id: 'other-account' }] },
  ])('renders no link for a connection that $case', ({ accounts }) => {
    mockAccounts = accounts
    renderCard({ reviewType: 'api' })

    expect(screen.queryByTestId('proxy-review-connection-link')).not.toBeInTheDocument()
    expect(screen.queryByTestId('proxy-review-permissions-btn')).not.toBeInTheDocument()
    expect(screen.getByText('Railway')).toBeInTheDocument()
  })
})
