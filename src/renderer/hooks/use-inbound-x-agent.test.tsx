// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { InboundXAgentCaller } from '@shared/lib/types/inbound-x-agent-schema'

const state = vi.hoisted(() => ({
  patches: [] as Array<{ url: string; body: unknown }>,
  failOn: null as string | null,
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { operation: string }
    if (state.failOn === body.operation) {
      return new Response(JSON.stringify({ error: 'Only a User or Owner of both agents can change this connection.' }), { status: 403 })
    }
    state.patches.push({ url, body })
    return new Response(JSON.stringify({ ok: true }))
  }),
}))

import { useSetAgentAccessRole } from './use-inbound-x-agent'

function caller(decision: 'allow' | 'review', readDecision: 'allow' | 'review'): InboundXAgentCaller {
  return { slug: 'triage', displaySlug: 'inbox-triage', name: 'Inbox Triage', decision, readDecision, canAccess: true }
}

function setRole() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  )
  return renderHook(() => useSetAgentAccessRole('support'), { wrapper }).result.current.mutateAsync
}

const patch = (operation: string, decision: string) => ({
  url: '/api/agents/triage/x-agent-policies',
  body: { operation, targetSlug: 'support', decision },
})

beforeEach(() => {
  state.patches = []
  state.failOn = null
})

describe('useSetAgentAccessRole', () => {
  it('makes an agent a User by letting it send without asking', async () => {
    await setRole()({ caller: caller('review', 'review'), role: 'user' })
    expect(state.patches).toEqual([patch('invoke', 'allow')])
  })

  it('makes an agent a Viewer by letting it read, and nothing more', async () => {
    await setRole()({ caller: caller('review', 'review'), role: 'viewer' })
    expect(state.patches).toEqual([patch('read', 'allow')])
  })

  it('takes sending away before it grants reading when a User becomes a Viewer', async () => {
    await setRole()({ caller: caller('allow', 'review'), role: 'viewer' })
    expect(state.patches).toEqual([patch('invoke', 'review'), patch('read', 'allow')])
  })

  it('removes an agent by pinning Review on everything it was allowed', async () => {
    await setRole()({ caller: caller('allow', 'allow'), role: null })
    expect(state.patches).toEqual([patch('invoke', 'review'), patch('read', 'review')])
  })

  it('stops at the first refusal and reports why', async () => {
    state.failOn = 'invoke'
    await expect(setRole()({ caller: caller('allow', 'review'), role: 'viewer' }))
      .rejects.toThrow('Only a User or Owner of both agents can change this connection.')
    expect(state.patches).toEqual([])
  })
})
