// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { useStaleSession, type UseStaleSessionArgs } from './use-stale-session'
import { DraftsProvider, useDraftsStore } from '@renderer/context/drafts-context'
import { carryoverKey, type ComposerSnapshot, type NewChatCarryover } from '@renderer/lib/composer-carryover'
import type { SessionUsage } from '@shared/lib/types/agent'

// Override setup.ts's global no-op useNavigate with a spy so we can assert that
// "Start fresh" navigates to the agent's new-chat composer.
const { navigateSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn() }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => navigateSpy }
})

// Idle > 6h AND current context > 100k → trips the stale gate.
const staleUsage: SessionUsage = {
  inputTokens: 5000,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 130_000,
  contextWindow: 200_000,
}
const idle7h = () => new Date(Date.now() - 7 * 60 * 60 * 1000)

function baseArgs(over: Partial<UseStaleSessionArgs> = {}): UseStaleSessionArgs {
  return {
    sessionId: 's-1',
    agentSlug: 'agent-1',
    isActive: false,
    isWaitingBackground: false,
    isAwaitingInput: false,
    isViewOnly: false,
    lastActivityAt: idle7h(),
    contextUsage: staleUsage,
    ...over,
  }
}

const wrapper = ({ children }: { children: ReactNode }) => createElement(DraftsProvider, null, children)

// Render the hook alongside the drafts store so tests can assert what Start fresh wrote.
function renderStale(args: UseStaleSessionArgs) {
  return renderHook(({ a }: { a: UseStaleSessionArgs }) => ({ stale: useStaleSession(a), store: useDraftsStore() }), {
    wrapper,
    initialProps: { a: args },
  })
}

describe('useStaleSession detection', () => {
  it('does not prompt for a fresh (not idle, small context) conversation', () => {
    const { result } = renderStale(baseArgs({ lastActivityAt: new Date(), contextUsage: null }))
    expect(result.current.stale.showToast).toBe(false)
  })

  it('prompts when idle long enough AND context is large, at rest', () => {
    const { result } = renderStale(baseArgs())
    expect(result.current.stale.showToast).toBe(true)
  })

  it('never prompts while the session is active', () => {
    const { result } = renderStale(baseArgs({ isActive: true }))
    expect(result.current.stale.showToast).toBe(false)
  })

  it('never prompts while awaiting input', () => {
    const { result } = renderStale(baseArgs({ isActive: true, isAwaitingInput: true }))
    expect(result.current.stale.showToast).toBe(false)
  })

  it('never prompts for view-only users (they cannot start fresh)', () => {
    const { result } = renderStale(baseArgs({ isViewOnly: true }))
    expect(result.current.stale.showToast).toBe(false)
  })

  it('hides the toast after Ignore (local, no persistence)', () => {
    const { result } = renderStale(baseArgs())
    expect(result.current.stale.showToast).toBe(true)
    act(() => result.current.stale.ignore())
    expect(result.current.stale.showToast).toBe(false)
  })
})

describe('useStaleSession active->idle clock', () => {
  it('does not re-trip immediately after a turn finishes (active -> idle resets the idle clock)', () => {
    const { result, rerender } = renderStale(baseArgs({ isActive: true }))
    // Turn just completed: active -> idle. The live signal stamps "now", so even
    // though lastActivityAt is 7h old, the conversation is not treated as idle.
    rerender({ a: baseArgs({ isActive: false }) })
    expect(result.current.stale.showToast).toBe(false)
  })
})

describe('useStaleSession conversation change', () => {
  it('clears local Ignore when the conversation changes (Ignore is per-conversation)', () => {
    const { result, rerender } = renderStale(baseArgs())
    act(() => result.current.stale.ignore())
    expect(result.current.stale.showToast).toBe(false)
    rerender({ a: baseArgs({ sessionId: 's-2' }) })
    expect(result.current.stale.showToast).toBe(true)
  })
})

describe('useStaleSession Start fresh', () => {
  beforeEach(() => navigateSpy.mockClear())

  function startFreshWith(snapshot: ComposerSnapshot, result: ReturnType<typeof renderStale>['result']) {
    act(() => result.current.stale.registerSnapshot(() => snapshot))
    act(() => result.current.stale.startFresh())
  }

  it('carries text + model/effort into the agent draft + carry-over, clears the source, then navigates', () => {
    const { result } = renderStale(baseArgs())
    startFreshWith({ text: 'pick this up later', attachments: [], model: 'sonnet', effort: 'low' }, result)

    expect(result.current.store.get('agent:agent-1')).toBe('pick this up later')
    expect(result.current.store.get<NewChatCarryover>(carryoverKey('agent-1'))).toEqual({
      attachments: [],
      model: 'sonnet',
      effort: 'low',
    })
    // Source session draft is cleared — Start fresh is a move, not a copy.
    expect(result.current.store.get('session:s-1')).toBeUndefined()
    expect(navigateSpy).toHaveBeenCalledWith({ to: '/agents/$slug', params: { slug: 'agent-1' } })
  })

  it('carries model/effort but leaves the agent draft untouched when the composer is empty', () => {
    const { result } = renderStale(baseArgs())
    startFreshWith({ text: '   ', attachments: [], model: 'opus', effort: 'high' }, result)

    // A blank composer must not clobber an existing agent-home draft.
    expect(result.current.store.get('agent:agent-1')).toBeUndefined()
    expect(result.current.store.get<NewChatCarryover>(carryoverKey('agent-1'))).toEqual({
      attachments: [],
      model: 'opus',
      effort: 'high',
    })
    expect(navigateSpy).toHaveBeenCalledOnce()
  })
})
