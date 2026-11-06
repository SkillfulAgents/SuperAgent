// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProxyReviewRequestItem } from './request'
import { gmailSendCustomPreview } from './gmail-send'
import { labelDefaultKey } from '@shared/lib/proxy/policy-sentinels'
import { matchScopes } from '@shared/lib/proxy/scope-matcher'
import { canonicalizeTargetPath } from '@shared/lib/proxy/target-path'
import { requestBodyPreview } from '@shared/lib/proxy/review-display'
import { parseRuleProposal } from '@shared/lib/proxy/rules/proposal-schema'

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

  describe('of a call a custom preview draws', () => {
    const gmailSend = (mime: string) => ({
      toolkit: 'gmail',
      targetPath: 'gmail/v1/users/me/messages/send',
      displayText: 'Allow sending a message?',
      requestBody: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }, null, 2),
    })

    it('is the custom preview\'s once it reads the body', async () => {
      renderCard(gmailSend('To: dana@acme.com\r\nSubject: Hi\r\n\r\nhello'))
      expect(await screen.findByText('Allow sending this email from Gmail?')).toBeTruthy()
      expect(screen.getByTestId('gmail-send')).toBeTruthy()
      expect(screen.queryByText('Allow sending a message?')).toBeNull()
      // The preview names the call, so the raw request folds even with no endpoint description.
      expect(screen.queryByTestId('proxy-review-body')).toBeNull()
    })

    it('is the custom preview\'s alone when the body is too long to draw', async () => {
      const content = Buffer.from('x'.repeat(60_000)).toString('base64')
      renderCard({ toolkit: 'github', method: 'PUT', targetPath: 'repos/acme/api/contents/src/big.ts', displayText: 'Allow create or update file contents?', requestBody: requestBodyPreview(new TextEncoder().encode(JSON.stringify({ message: 'Add', content })).buffer) })
      expect((await screen.findByText('src/big.ts')).tagName).toBe('CODE')
      expect(screen.queryByText('Allow create or update file contents?')).toBeNull()
      // Nothing is drawn, so the raw request stays open as it is today.
      expect(screen.getByTestId('proxy-review-body')).toBeTruthy()
    })

    it('stays the endpoint\'s when the body does not read', async () => {
      const props = gmailSend('Resent-To: hidden@elsewhere.io\r\nTo: dana@acme.com\r\n\r\nhello')
      renderCard(props)
      // The card's read started first, so it has settled once this one has.
      await act(async () => { await gmailSendCustomPreview.read(props.requestBody) })
      expect(screen.getByText('Allow sending a message?')).toBeTruthy()
      expect(screen.queryByText('Allow sending this email from Gmail?')).toBeNull()
      expect(screen.queryByTestId('gmail-send')).toBeNull()
    })
  })
})

describe('ProxyReviewRequestItem "always" policy routing', () => {
  beforeEach(() => {
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

  it('sends the label default for the smallest risk group', async () => {
    const user = userEvent.setup()
    renderCard({ toolkit: 'linear', targetPath: 'graphql', matchedScopes: ['read'], endpointDescription: 'Query: issues - List issues with filters' })
    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    await user.click(await screen.findByTestId('proxy-review-allow-label-read'))
    expect(sentBody()).toMatchObject({ decision: 'allow', scope: labelDefaultKey('read'), reviewType: 'api' })
  })

  it('offers and saves the read group for GitHub check runs despite the broad repo scope', async () => {
    const targetPath = 'repos/SkillfulAgents/iOS-App/commits/126311d90f14c14e7ca8a69f1753242a272ad5c7/check-runs'
    const match = matchScopes('github', 'GET', targetPath)
    const user = userEvent.setup()
    renderCard({
      toolkit: 'github',
      method: 'GET',
      targetPath,
      matchedScopes: match.scopes,
      scopeDescriptions: match.descriptions,
      endpointDescription: match.endpointDescription,
    })

    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    expect(screen.queryByTestId('proxy-review-allow-label-destructive')).not.toBeInTheDocument()
    await user.click(await screen.findByTestId('proxy-review-allow-label-read'))
    expect(sentBody()).toMatchObject({ decision: 'allow', scope: '*read', reviewType: 'api' })
  })

  it.each([
    ['POST', 'v4/spreadsheets/id:batchUpdate', 'write'],
    ['POST', "v4/spreadsheets/id/values/'October%2F2026'!A1:B2:append", 'write'],
    ['GET', "v4/spreadsheets/id/values/'October%2F2026'!A1:B2", 'read'],
  ])('offers and saves the Sheets %s %s %s group', async (method, path, label) => {
    const target = canonicalizeTargetPath(`sheets.googleapis.com/${path}`, 'sheets.googleapis.com')
    if (!target.ok) throw new Error(target.error)
    const match = matchScopes('googlesheets', method, target.path)
    const user = userEvent.setup()
    renderCard({
      toolkit: 'googlesheets',
      method,
      targetPath: target.path,
      matchedScopes: match.scopes,
      scopeDescriptions: match.descriptions,
      endpointDescription: match.endpointDescription,
    })
    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    expect(screen.queryByTestId('proxy-review-allow-label-destructive')).not.toBeInTheDocument()
    await user.click(await screen.findByTestId(`proxy-review-allow-label-${label}`))
    expect(sentBody()).toMatchObject({ decision: 'allow', scope: `*${label}`, reviewType: 'api' })
  })

  it('sends the stamped api type even when the path looks like a tool call', async () => {
    renderCard({ reviewType: 'api', targetPath: 'tools/call: something' })
    await chooseAlwaysAllowAll()

    expect(sentBody()).toMatchObject({ reviewType: 'api' })
  })

  it.each([
    { targetPath: 'tools/call: list_issues', expected: 'mcp' },
    { targetPath: 'gmail/v1/users/me/messages', expected: 'api' },
  ])('falls back to the path prefix for an unstamped review ($targetPath → $expected)', async ({ targetPath, expected }) => {
    renderCard({ targetPath })
    await chooseAlwaysAllowAll()

    expect(sentBody()).toMatchObject({ reviewType: expected })
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

  it('offers the label allow on an API card only when the headline names the call', async () => {
    const user = userEvent.setup()
    const { unmount } = renderCard({ toolkit: 'linear', targetPath: 'graphql', matchedScopes: ['read', 'write'] })
    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    expect(await screen.findByTestId('proxy-review-always-allow-all')).toBeInTheDocument()
    expect(screen.queryByTestId('proxy-review-allow-label-read')).toBeNull()
    await user.click(screen.getByTestId('proxy-review-deny-btn-chevron'))
    expect(await screen.findByTestId('proxy-review-deny-reason-input')).toBeInTheDocument()
    unmount()
    renderCard({ toolkit: 'linear', targetPath: 'graphql', matchedScopes: ['read'], endpointDescription: 'Query: issues - List issues with filters' })
    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    expect(await screen.findByTestId('proxy-review-allow-label-read')).toBeInTheDocument()
  })

  it('explains a menu option on keyboard focus, not on opening the menu', async () => {
    const user = userEvent.setup()
    renderCard({ toolkit: 'linear', targetPath: 'graphql', matchedScopes: ['read'], endpointDescription: 'Query: issues - List issues with filters' })
    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    await screen.findByTestId('proxy-review-allow-label-read')
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => screen.getByTestId('proxy-review-allow-label-read').focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Auto-allow every read-level scope for this account')
  })

  it('offers only Allow Once when a require rule held the request', () => {
    renderCard({
      ruleOutcomes: [{ ruleId: 'r1', version: 1, effect: 'require', restatement: 'Review every post', result: 'false' }],
    })
    expect(screen.getByTestId('proxy-review-allow-once-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('proxy-review-always-allow-btn')).toBeNull()
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

  it('opens the connection page from the Allow menu', async () => {
    mockAccounts = [{ id: 'acct-or-mcp' }]
    renderCard({ reviewType: 'api' })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    await user.click(await screen.findByTestId('proxy-review-edit-permissions'))

    expect(mockNavigate).toHaveBeenCalledOnce()
    expect(mockNavigate.mock.calls[0][0]).toMatchObject({ search: { detail: 'account-acct-or-mcp' } })
  })

  it('links the toolkit name on the answered card', async () => {
    mockApiFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    mockAccounts = [{ id: 'acct-or-mcp' }]
    renderCard({ reviewType: 'api' })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('proxy-review-allow-once-btn'))
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
    expect(screen.getByText('Railway')).toBeInTheDocument()
  })
})

describe('ProxyReviewRequestItem rule proposal', () => {
  it('draws backticked values as code and leaves the rest of the text literal', () => {
    const ruleProposal = parseRuleProposal({
      ruleKind: 'api', targetId: 'acct-1', targetName: 'Notion', appliesTo: 'agent', effect: 'allow',
      description: 'Allow reads of `page` objects.',
      restatement: 'For requests to `api.notion.com`, this allows `POST /v1/search`, GET /v1/*/children and GET /v1/* only when `page_size` is at most 50.',
      patterns: ['POST /v1/search'], code: 'return true', tests: [], coverage: [], warnings: [],
    })
    renderCard({ ruleProposal })

    const restatement = screen.getByTestId('rule-proposal-restatement')
    expect(restatement.textContent).toBe('For requests to api.notion.com, this allows POST /v1/search, GET /v1/*/children and GET /v1/* only when page_size is at most 50.')
    expect([...restatement.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['api.notion.com', 'POST /v1/search', 'page_size'])
    const description = screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Allow reads of page objects.')
    expect(description.querySelector('code')?.textContent).toBe('page')
  })
})
