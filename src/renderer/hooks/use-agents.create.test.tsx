// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch }))
vi.mock('@renderer/context/analytics-context', () => ({ useAnalyticsTracking: () => ({ track: vi.fn() }) }))
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({}) }))

import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { seedOwnerRole, useCreateAgent } from './use-agents'

const ROLES = ['my-agent-roles']
const created = { slug: 'abcd123456', displaySlug: 'untitled-abcd123456', name: 'Untitled' }

function renderCreateAgent(client: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(() => useCreateAgent(), { wrapper }).result
}

describe('creating an agent', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(async () => Response.json(created, { status: 201 }))
  })

  it('makes the creator the owner in the held roles before they are fetched again', async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    client.setQueryData(ROLES, { zzzz999999: { role: 'viewer', memberCount: 3 } })

    await renderCreateAgent(client).current.mutateAsync({ name: 'Untitled' })

    // Read at once: nothing has answered the refetch of the roles.
    expect(client.getQueryData(ROLES)).toEqual({
      zzzz999999: { role: 'viewer', memberCount: 3 },
      abcd123456: { role: 'owner', memberCount: 1 },
    })
    expect(client.getQueryState(ROLES)?.isInvalidated).toBe(true)
  })

  it('holds no roles where none were fetched, as outside auth mode', async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

    await renderCreateAgent(client).current.mutateAsync({ name: 'Untitled' })

    expect(client.getQueryData(ROLES)).toBeUndefined()
  })
})

describe('seedOwnerRole', () => {
  it('keeps the role the list already has for the agent', () => {
    const client = new QueryClient()
    client.setQueryData(ROLES, { abcd123456: { role: 'owner', memberCount: 4 } })

    seedOwnerRole(client, 'abcd123456')

    expect(client.getQueryData(ROLES)).toEqual({ abcd123456: { role: 'owner', memberCount: 4 } })
  })
})
