// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProxyReviewRequestItem } from './request'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
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

describe('ProxyReviewRequestItem request body', () => {
  const body = 'mutation { issueDelete(id: "LIN-1") { success } }'

  it('opens what the call sends when the headline cannot name the call, and folds it when it can', () => {
    const { unmount } = renderCard({ toolkit: 'linear', targetPath: 'graphql', requestBody: body })
    expect(screen.getByTestId('proxy-review-body')).toHaveTextContent(body)
    unmount()
    renderCard({ toolkit: 'gmail', targetPath: 'gmail/v1/users/me/messages/send', requestBody: '{}', endpointDescription: 'Send an email' })
    expect(screen.queryByTestId('proxy-review-body')).toBeNull()
  })

  it('offers label and scope allows on an API card only when the headline names the call', async () => {
    const user = userEvent.setup()
    const { unmount } = renderCard({ toolkit: 'linear', targetPath: 'graphql', matchedScopes: ['read', 'write'] })
    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    expect(await screen.findByTestId('proxy-review-allow-once-menu-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('proxy-review-allow-label-read')).toBeNull()
    expect(screen.queryByTestId('proxy-review-specific-scope-toggle')).toBeNull()
    await user.click(screen.getByTestId('proxy-review-deny-btn-chevron'))
    expect(await screen.findByTestId('proxy-review-deny-reason-input')).toBeInTheDocument()
    expect(screen.getByTestId('proxy-review-always-deny-read')).toBeInTheDocument()
    unmount()
    renderCard({ toolkit: 'linear', targetPath: 'graphql', matchedScopes: ['read'], endpointDescription: 'Query: issues - List issues with filters' })
    await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
    expect(await screen.findByTestId('proxy-review-allow-label-read')).toBeInTheDocument()
    expect(screen.getByTestId('proxy-review-specific-scope-toggle')).toBeInTheDocument()
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
