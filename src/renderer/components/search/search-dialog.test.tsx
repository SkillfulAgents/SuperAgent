// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { SearchProvider } from '@renderer/context/search-context'
import * as api from '@renderer/lib/api'
import type { ApiAgent, ApiSession } from '@shared/lib/types/api'
import { SearchDialog } from './search-dialog'

vi.mock('@renderer/components/agents/agent-avatar/agent-avatar', () => ({
  AgentAvatar: ({ state }: { state: string }) => <span data-testid="orb" data-state={state} />,
}))

it('updates recent and filtered avatars from the shared agents query while search stays open', async () => {
  const now = new Date()
  const agent: ApiAgent = {
    slug: 'alpha', displaySlug: 'alpha', name: 'Alpha', createdAt: now, lastActivityAt: now,
    status: 'running', containerPort: null, avatar: { color: 'tonal-blue', shape: 'circle' },
    dashboards: [{ name: 'Alpha dashboard', slug: 'alpha-dashboard' }],
  }
  const session: ApiSession = { id: 's1', agentSlug: agent.slug, name: 'Alpha session', createdAt: now, lastActivityAt: now }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['agents'], [agent])
  client.setQueryData(['sessions', agent.slug], [session])
  const fetch = vi.spyOn(api, 'apiFetch').mockResolvedValue(Response.json([{ ...agent, hasActiveSessions: true }]))
  render(<QueryClientProvider client={client}><SearchProvider><SearchDialog /></SearchProvider></QueryClientProvider>)
  fireEvent.keyDown(window, { key: 'k', metaKey: true })

  async function expectRows(state: string, badge?: string, filtered = true) {
    const kinds = filtered ? ['agent', 'session', 'dashboard'] : ['agent', 'session']
    await waitFor(() => {
      for (const kind of kinds) {
        const row = within(screen.getByTestId(`search-${kind}-row`))
        expect(row.getByTestId('orb')).toHaveAttribute('data-state', state)
        if (state === 'working') expect(row.getByText('(working)')).toHaveClass('motion-reduce:not-sr-only')
        if (badge) expect(row.getByRole('img')).toHaveAccessibleName(badge)
        else expect(row.queryByRole('img')).toBeNull()
      }
    })
  }

  await expectRows('idle', undefined, false)
  fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'alpha' } })
  await expectRows('idle')
  expect(fetch).not.toHaveBeenCalled()

  await act(() => client.invalidateQueries({ queryKey: ['agents'], exact: true }))
  await expectRows('working')
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/agents')

  const update = (patch: Partial<ApiAgent>) => act(() => {
    client.setQueryData(['agents'], [{ ...agent, ...patch }])
  })
  update({ hasActiveSessions: true, hasUnreadNotifications: true, hasUnreadMention: true })
  await expectRows('working', 'mentioned you')
  update({ hasActiveSessions: true, hasUnreadNotifications: true, hasUnreadMention: true, hasSessionsAwaitingInput: true })
  await expectRows('needs-input', 'needs input')
  update({ hasUnreadNotifications: true })
  await expectRows('done', 'unread notifications')
  update({ status: 'stopped' })
  await expectRows('sleeping')
  expect(fetch).toHaveBeenCalledTimes(1)
})
