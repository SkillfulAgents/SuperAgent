// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { renderWithProviders, screen, waitFor, within } from '@renderer/test/test-utils'
import { ProxyReviewRequestItem } from './request'

// The real permissions editor inside the card: GET loads rules, PUT saves, POST answers the review.
let rulesResponse: { ok: boolean; policies: Array<{ scope: string; decision: string }> } = { ok: true, policies: [] }
const calls: string[] = []
const mockApiFetch = vi.fn((url: string, opts?: { method?: string }) => {
  if (url.startsWith('/api/policies/scope/')) {
    if (opts?.method === 'PUT') {
      calls.push('PUT rules')
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
    }
    return Promise.resolve({ ok: rulesResponse.ok, json: () => Promise.resolve(rulesResponse.ok ? { policies: rulesResponse.policies } : { error: 'boom' }) })
  }
  calls.push(`POST ${url}`)
  return Promise.resolve(new Response('{"ok":true}', { status: 200 }))
})
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...(args as [string, never])),
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ state: { location: { pathname: '/agents/my-agent/sessions/s1', searchStr: '' } } }),
}))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({
  useAgentConnectedAccounts: () => ({ data: { accounts: [{ id: 'acct-1', displayName: 'Work Gmail' }] } }),
}))
vi.mock('@renderer/hooks/use-remote-mcps', () => ({
  useAgentRemoteMcps: () => ({ data: { mcps: [] } }),
}))

async function openMenu(matchedScopes = ['gmail.send']) {
  renderWithProviders(
    <ProxyReviewRequestItem
      reviewId="review-1"
      agentSlug="my-agent"
      accountId="acct-1"
      reviewType="api"
      toolkit="gmail"
      method="POST"
      targetPath="gmail/v1/users/me/messages/send"
      matchedScopes={matchedScopes}
      scopeDescriptions={{}}
      onComplete={vi.fn()}
    />,
  )
  const user = userEvent.setup()
  await user.click(screen.getByTestId('proxy-review-always-allow-btn'))
  await waitFor(() => expect(screen.getByTestId('group-default-read')).toBeInTheDocument())
  return user
}

describe('review card with the real permissions editor', () => {
  beforeEach(() => {
    calls.length = 0
    rulesResponse = { ok: true, policies: [] }
  })

  it('says which permission the request needs and tags it in the editor', async () => {
    await openMenu()

    expect(screen.getByTestId('proxy-review-request-scopes')).toHaveTextContent('This request needs gmail.send (Write/Delete actions)')
    expect(screen.getByTestId('scope-group-request-write')).toBeInTheDocument()
  })

  it('names every scope that would let a multi-scope request through', async () => {
    await openMenu(['gmail.send', 'gmail.compose'])

    expect(screen.getByTestId('proxy-review-request-scopes')).toHaveTextContent(
      'This request needs any of gmail.send (Write/Delete actions), gmail.compose (Write/Delete actions)',
    )
  })

  it('saves the rules before it answers the review with Save & Allow', async () => {
    const user = await openMenu()
    await user.click(screen.getByRole('button', { name: 'Save & Allow' }))

    await waitFor(() => expect(calls).toEqual(['PUT rules', 'POST /api/agents/my-agent/proxy-review/review-1']))
  })

  it('never saves over rules it failed to load, even after an edit', async () => {
    rulesResponse = { ok: false, policies: [] }
    const user = await openMenu()
    await user.click(within(screen.getByTestId('group-default-read')).getByTestId('policy-dropdown-trigger'))
    await user.click(await screen.findByTestId('policy-menu-block'))
    await user.click(screen.getByRole('button', { name: 'Allow Once' }))

    await waitFor(() => expect(calls).toEqual(['POST /api/agents/my-agent/proxy-review/review-1']))
  })
})
