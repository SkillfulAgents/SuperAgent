// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch }))
vi.mock('@renderer/context/analytics-context', () => ({ useAnalyticsTracking: () => ({ track: vi.fn() }) }))
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({}) }))

import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useStartAgent } from './use-agents'

function renderStartAgent() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(() => useStartAgent(), { wrapper }).result
}

describe('useStartAgent request', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(async () => Response.json(null))
  })

  it('posts no body for a plain start, as before', async () => {
    const start = renderStartAgent()

    await start.current.mutateAsync({ slug: 'agent-1', source: 'warm-start' })
    await start.current.mutateAsync('agent-1')

    expect(apiFetch.mock.calls).toEqual([
      ['/api/agents/agent-1/start', { method: 'POST' }],
      ['/api/agents/agent-1/start', { method: 'POST' }],
    ])
  })

  it('names the session to pre-resume in a JSON body', async () => {
    const start = renderStartAgent()

    await start.current.mutateAsync({ slug: 'agent-1', source: 'warm-start', sessionId: 'session-1' })

    expect(apiFetch).toHaveBeenCalledWith('/api/agents/agent-1/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    })
  })
})
