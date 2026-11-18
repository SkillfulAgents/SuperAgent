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

import { useSetAgentAccess } from './use-inbound-x-agent'

function caller(decision: 'allow' | 'review', readDecision: 'allow' | 'review'): InboundXAgentCaller {
  return { slug: 'triage', displaySlug: 'inbox-triage', name: 'Inbox Triage', decision, readDecision, canAccess: true }
}

function setAccess() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  )
  return renderHook(() => useSetAgentAccess('support'), { wrapper }).result.current.mutateAsync
}

const patch = (operation: string, decision: string, from = 'triage', to = 'support') => ({
  url: `/api/agents/${from}/x-agent-policies`,
  body: { operation, targetSlug: to, decision },
})

beforeEach(() => {
  state.patches = []
  state.failOn = null
})

describe('useSetAgentAccess', () => {
  it('makes an agent a User by letting it message and read', async () => {
    await setAccess()({ agent: caller('review', 'review'), change: 'user' })
    expect(state.patches).toEqual([patch('invoke', 'allow'), patch('read', 'allow')])
  })

  it('takes messaging away before it grants reading when a User becomes a Viewer', async () => {
    await setAccess()({ agent: caller('allow', 'review'), change: 'viewer' })
    expect(state.patches).toEqual([patch('invoke', 'review'), patch('read', 'allow')])
  })

  it('removes an agent by pinning Review on everything it was allowed', async () => {
    await setAccess()({ agent: caller('allow', 'allow'), change: 'remove' })
    expect(state.patches).toEqual([patch('invoke', 'review'), patch('read', 'review')])
  })

  it('blocks reading and messaging in both directions', async () => {
    await setAccess()({ agent: caller('allow', 'allow'), change: 'block' })
    expect(state.patches).toEqual([
      patch('invoke', 'block'),
      patch('read', 'block'),
      patch('invoke', 'block', 'support', 'triage'),
      patch('read', 'block', 'support', 'triage'),
    ])
  })

  it('lifts a block to Review, then takes away what the agent still holds before granting the pick', async () => {
    // Reading is blocked, messaging still allowed: Viewer must end with messaging on Review, not allowed.
    const blocked = {
      slug: 'triage', displaySlug: 'inbox-triage', name: 'Inbox Triage', avatar: null, canAccess: true,
      decision: 'allow' as const, readDecision: 'block' as const,
      blocks: [{ callerSlug: 'triage', operation: 'read' as const }],
    }
    await setAccess()({ agent: blocked, change: 'viewer' })
    expect(state.patches).toEqual([patch('invoke', 'review'), patch('read', 'review'), patch('read', 'allow')])
  })

  it('lifts an invoke block and takes away a read the agent still holds on Remove block', async () => {
    const blocked = {
      slug: 'triage', displaySlug: 'inbox-triage', name: 'Inbox Triage', avatar: null, canAccess: true,
      decision: 'block' as const, readDecision: 'allow' as const,
      blocks: [{ callerSlug: 'triage', operation: 'invoke' as const }],
    }
    await setAccess()({ agent: blocked, change: 'remove' })
    expect(state.patches).toEqual([patch('read', 'review'), patch('invoke', 'review')])
  })

  it('keeps a block while what it guards is still allowed: a refused take-away lifts nothing', async () => {
    state.failOn = 'invoke'
    const blocked = {
      slug: 'triage', displaySlug: 'inbox-triage', name: 'Inbox Triage', avatar: null, canAccess: true,
      decision: 'allow' as const, readDecision: 'block' as const,
      blocks: [{ callerSlug: 'triage', operation: 'read' as const }],
    }
    await expect(setAccess()({ agent: blocked, change: 'viewer' })).rejects.toThrow()
    expect(state.patches).toEqual([])
  })

  it('stops at the first refusal and reports why', async () => {
    state.failOn = 'invoke'
    await expect(setAccess()({ agent: caller('allow', 'review'), change: 'viewer' }))
      .rejects.toThrow('Only a User or Owner of both agents can change this connection.')
    expect(state.patches).toEqual([])
  })
})
