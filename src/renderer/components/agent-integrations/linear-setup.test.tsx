// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicLinearIntegration } from '@shared/lib/task-manager-integrations/linear/public'
import { makeChatIntegration } from './test-factories'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.request }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: async () => {} }) }))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({ agentIntegrationKeys: { detail: (id: string) => [id], status: (id: string) => [id], lists: (id: string) => [id] } }))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({}) }))
import { LinearConnectionSettings } from './linear-setup'
function integration(state: 'pending' | 'reconnect_needed' | 'connected' | 'setup_required'): PublicLinearIntegration {
  return { ...makeChatIntegration(), provider: 'linear', settings: { runOnStatusChange: false }, hasCredentials: state === 'connected', linear: {
    id: 'int-1', agentSlug: 'a', provider: 'linear', name: 'Helper', status: 'disconnected', errorMessage: null,
    identity: null, authorized: state === 'connected', authorizationState: state,
    authorizationMessage: state === 'reconnect_needed' ? 'Authorization expired. Start again to connect Linear.' : null,
    canReconnect: state !== 'setup_required', runOnStatusChange: false,
    setup: { creationUrl: 'https://linear.app/settings/api/applications/new', redirectUri: 'https://gamut.example/callback' },
  } }
}
beforeEach(() => { mocks.request.mockReset(); mocks.request.mockImplementation(async () => Response.json({ url: 'https://linear.app/oauth/authorize?state=fresh' })) })
describe('Linear authorization recovery', () => {
  it('retries with saved credentials, replaces the link, and drops expired links', async () => {
    const view = render(<LinearConnectionSettings integration={integration('reconnect_needed')} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Authorization expired')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect account' }))
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({})
    view.rerender(<LinearConnectionSettings integration={integration('pending')} />)
    expect(await screen.findByRole('link', { name: 'Authorize in Linear' })).toHaveAttribute('href', expect.stringContaining('state=fresh'))
    mocks.request.mockResolvedValueOnce(Response.json({ url: 'https://linear.app/oauth/authorize?state=second' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    await waitFor(() => expect(screen.getByRole('link', { name: 'Authorize in Linear' })).toHaveAttribute('href', expect.stringContaining('state=second')))
    view.rerender(<LinearConnectionSettings integration={integration('reconnect_needed')} />)
    expect(screen.queryByRole('link', { name: 'Authorize in Linear' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reconnect account' })).toBeEnabled()
  })
  it('allows credential correction after a failed attempt', async () => {
    render(<LinearConnectionSettings integration={integration('reconnect_needed')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit app credentials' }))
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'correct-id' } })
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'correct-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue to authorization' }))
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({ clientId: 'correct-id', clientSecret: 'correct-secret' })
  })
  it('can restart pending authorization after reloading the page', async () => {
    render(<LinearConnectionSettings integration={integration('pending')} />)
    expect(screen.queryByRole('link', { name: 'Authorize in Linear' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    expect(await screen.findByRole('link', { name: 'Authorize in Linear' })).toHaveAttribute('href', expect.stringContaining('state=fresh'))
  })
})
