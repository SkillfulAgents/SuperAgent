// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftsProvider, useDraftsStore } from '@renderer/context/drafts-context'
import {
  newSessionCarryoverKey,
  type NewSessionCarryover,
} from '@renderer/lib/new-session-carryover'
import type { SessionUsage } from '@shared/lib/types/agent'
import { useStaleSession } from './use-stale-session'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => navigate }
})

const staleUsage: SessionUsage = {
  inputTokens: 10_000,
  outputTokens: 1_000,
  cacheReadInputTokens: 100_000,
  cacheCreationInputTokens: 0,
  contextWindow: 200_000,
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(DraftsProvider, null, children)

function renderStale(overrides: Partial<Parameters<typeof useStaleSession>[0]> = {}) {
  const args = {
    sessionId: 'session-1',
    agentSlug: 'abc123def4',
    routeAgentSlug: 'friendly-agent-abc123def4',
    isActive: false,
    isWaitingBackground: false,
    isAwaitingInput: false,
    isViewOnly: false,
    lastActivityAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    contextUsage: staleUsage,
    ...overrides,
  }
  return renderHook(() => ({ stale: useStaleSession(args), store: useDraftsStore() }), { wrapper })
}

describe('useStaleSession', () => {
  beforeEach(() => navigate.mockClear())

  it('shows for an old, large session at rest and hides when ignored', () => {
    const { result } = renderStale()
    expect(result.current.stale.showNotice).toBe(true)
    act(() => result.current.stale.ignore())
    expect(result.current.stale.showNotice).toBe(false)
  })

  it('does not show while active or for view-only users', () => {
    expect(renderStale({ isActive: true }).result.current.stale.showNotice).toBe(false)
    expect(renderStale({ isViewOnly: true }).result.current.stale.showNotice).toBe(false)
  })

  it('moves the live composer into a new conversation and navigates home', () => {
    const { result } = renderStale()
    act(() => result.current.stale.registerSnapshot(() => ({
      text: 'Continue as a new task',
      attachments: [],
      model: 'sonnet',
      effort: 'high',
    })))
    act(() => result.current.stale.startFresh())

    expect(result.current.store.get('agent:abc123def4')).toBe('Continue as a new task')
    expect(result.current.store.get<NewSessionCarryover>(newSessionCarryoverKey('abc123def4'))).toEqual({
      attachments: [],
      model: 'sonnet',
      effort: 'high',
    })
    expect(result.current.store.get('session:session-1')).toBeUndefined()
    expect(navigate).toHaveBeenCalledWith({
      to: '/agents/$slug',
      params: { slug: 'friendly-agent-abc123def4' },
    })
  })
})
