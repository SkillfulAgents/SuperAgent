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
