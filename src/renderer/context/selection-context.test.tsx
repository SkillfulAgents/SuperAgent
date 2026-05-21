// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { SelectionProvider, useSelection, type AgentView } from './selection-context'

function wrapper({ children }: { children: ReactNode }) {
  return createElement(SelectionProvider, null, children)
}

function setup() {
  return renderHook(() => useSelection(), { wrapper })
}

describe('SelectionContext — initial state', () => {
  it('starts with no agent selected and view=home', () => {
    const { result } = setup()
    expect(result.current.selectedAgentSlug).toBeNull()
    expect(result.current.view).toEqual({ kind: 'home' })
    expect(result.current.pendingDraft).toBeNull()
  })

  it('throws when used outside SelectionProvider', () => {
    expect(() => renderHook(() => useSelection())).toThrow(/SelectionProvider/)
  })
})

describe('SelectionContext — setAgent', () => {
  it('sets agent and resets view to home by default', () => {
    const { result } = setup()
    act(() => result.current.setView({ kind: 'session', id: 's1' }))
    act(() => result.current.setAgent('agent-1'))
    expect(result.current.selectedAgentSlug).toBe('agent-1')
    expect(result.current.view).toEqual({ kind: 'home' })
  })

  it('accepts an explicit view to land on directly', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'session', id: 's1' }))
    expect(result.current.selectedAgentSlug).toBe('agent-1')
    expect(result.current.view).toEqual({ kind: 'session', id: 's1' })
  })

  it('null clears agent and resets view to home', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'apiLogs' }))
    act(() => result.current.setAgent(null))
    expect(result.current.selectedAgentSlug).toBeNull()
    expect(result.current.view).toEqual({ kind: 'home' })
  })

  it('switching agents resets view to home (when no view passed)', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'dashboard', slug: 'd1' }))
    act(() => result.current.setAgent('agent-2'))
    expect(result.current.selectedAgentSlug).toBe('agent-2')
    expect(result.current.view).toEqual({ kind: 'home' })
  })
})

describe('SelectionContext — setView mutual exclusion', () => {
  // The whole point of the discriminated union: setting one view automatically
  // clears every other. Each test exercises a different starting view to prove
  // there's no field that survives the transition.
  const startingViews: AgentView[] = [
    { kind: 'home' },
    { kind: 'session', id: 's1' },
    { kind: 'task', id: 't1' },
    { kind: 'webhook', id: 'w1' },
    { kind: 'chat', integrationId: 'i1' },
    { kind: 'chat', integrationId: 'i1', sessionId: 'cs1' },
    { kind: 'dashboard', slug: 'd1' },
    { kind: 'apiLogs' },
    { kind: 'connections' },
  ]

  const targetViews: AgentView[] = [
    { kind: 'home' },
    { kind: 'session', id: 's2' },
    { kind: 'task', id: 't2' },
    { kind: 'webhook', id: 'w2' },
    { kind: 'chat', integrationId: 'i2' },
    { kind: 'chat', integrationId: 'i2', sessionId: 'cs2' },
    { kind: 'dashboard', slug: 'd2' },
    { kind: 'apiLogs' },
    { kind: 'connections' },
  ]

  for (const from of startingViews) {
    for (const to of targetViews) {
      it(`transitions ${JSON.stringify(from)} → ${JSON.stringify(to)} cleanly`, () => {
        const { result } = setup()
        act(() => result.current.setAgent('agent-1', from))
        act(() => result.current.setView(to))
        expect(result.current.view).toEqual(to)
        expect(result.current.selectedAgentSlug).toBe('agent-1')
      })
    }
  }
})

describe('SelectionContext — pendingDraft', () => {
  it('setAgentWithDraft stores draft and lands on home', () => {
    const { result } = setup()
    act(() => result.current.setAgentWithDraft('agent-1', 'hello world'))
    expect(result.current.selectedAgentSlug).toBe('agent-1')
    expect(result.current.view).toEqual({ kind: 'home' })
    expect(result.current.pendingDraft).toBe('hello world')
  })

  it('setAgentWithDraft from a non-home view resets to home (mutual exclusion)', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'apiLogs' }))
    act(() => result.current.setAgentWithDraft('agent-2', 'draft'))
    expect(result.current.view).toEqual({ kind: 'home' })
  })

  it('consumePendingDraft returns the draft and clears it', () => {
    const { result } = setup()
    act(() => result.current.setAgentWithDraft('agent-1', 'draft text'))
    let consumed: string | null = null
    act(() => { consumed = result.current.consumePendingDraft() })
    expect(consumed).toBe('draft text')
    expect(result.current.pendingDraft).toBeNull()
  })

  it('consumePendingDraft returns null when no draft', () => {
    const { result } = setup()
    let consumed: string | null = null
    act(() => { consumed = result.current.consumePendingDraft() })
    expect(consumed).toBeNull()
  })

  it('subsequent consume returns null', () => {
    const { result } = setup()
    act(() => result.current.setAgentWithDraft('agent-1', 'd'))
    act(() => { result.current.consumePendingDraft() })
    let second: string | null = 'sentinel'
    act(() => { second = result.current.consumePendingDraft() })
    expect(second).toBeNull()
  })

  it('setAgent (without draft) does not affect existing pendingDraft', () => {
    // Drafts are orthogonal to agent/view selection. They survive until consumed.
    const { result } = setup()
    act(() => result.current.setAgentWithDraft('agent-1', 'preserve me'))
    act(() => result.current.setAgent('agent-2'))
    expect(result.current.pendingDraft).toBe('preserve me')
  })
})

describe('SelectionContext — clearSelection', () => {
  it('resets agent and view from any state', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'session', id: 's1' }))
    act(() => result.current.clearSelection())
    expect(result.current.selectedAgentSlug).toBeNull()
    expect(result.current.view).toEqual({ kind: 'home' })
  })

  it('is idempotent', () => {
    const { result } = setup()
    act(() => result.current.clearSelection())
    act(() => result.current.clearSelection())
    expect(result.current.selectedAgentSlug).toBeNull()
    expect(result.current.view).toEqual({ kind: 'home' })
  })
})

describe('SelectionContext — handleAgentDeleted', () => {
  it('clears selection when the deleted agent is the selected one', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'session', id: 's1' }))
    act(() => result.current.handleAgentDeleted('agent-1'))
    expect(result.current.selectedAgentSlug).toBeNull()
    expect(result.current.view).toEqual({ kind: 'home' })
  })

  it('is a no-op when a different agent is selected', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'apiLogs' }))
    act(() => result.current.handleAgentDeleted('other-agent'))
    expect(result.current.selectedAgentSlug).toBe('agent-1')
    expect(result.current.view).toEqual({ kind: 'apiLogs' })
  })

  it('is a no-op when no agent is selected', () => {
    const { result } = setup()
    act(() => result.current.handleAgentDeleted('any'))
    expect(result.current.selectedAgentSlug).toBeNull()
    expect(result.current.view).toEqual({ kind: 'home' })
  })
})

describe('SelectionContext — handleSessionDeleted', () => {
  it('returns to home when the deleted session is being viewed', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'session', id: 's1' }))
    act(() => result.current.handleSessionDeleted('s1'))
    expect(result.current.view).toEqual({ kind: 'home' })
    expect(result.current.selectedAgentSlug).toBe('agent-1')
  })

  it('does nothing when viewing a different session', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'session', id: 's1' }))
    act(() => result.current.handleSessionDeleted('s2'))
    expect(result.current.view).toEqual({ kind: 'session', id: 's1' })
  })

  it('does nothing when not in a session view', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'apiLogs' }))
    act(() => result.current.handleSessionDeleted('s1'))
    expect(result.current.view).toEqual({ kind: 'apiLogs' })
  })
})

describe('SelectionContext — handleScheduledTaskDeleted', () => {
  it('returns to home when viewing the deleted task', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'task', id: 't1' }))
    act(() => result.current.handleScheduledTaskDeleted('t1'))
    expect(result.current.view).toEqual({ kind: 'home' })
  })

  it('does nothing when viewing a different task', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'task', id: 't1' }))
    act(() => result.current.handleScheduledTaskDeleted('t2'))
    expect(result.current.view).toEqual({ kind: 'task', id: 't1' })
  })
})

describe('SelectionContext — handleWebhookTriggerDeleted', () => {
  it('returns to home when viewing the deleted trigger', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'webhook', id: 'w1' }))
    act(() => result.current.handleWebhookTriggerDeleted('w1'))
    expect(result.current.view).toEqual({ kind: 'home' })
  })

  it('does nothing when viewing a different trigger', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'webhook', id: 'w1' }))
    act(() => result.current.handleWebhookTriggerDeleted('w2'))
    expect(result.current.view).toEqual({ kind: 'webhook', id: 'w1' })
  })
})

describe('SelectionContext — handleChatIntegrationDeleted', () => {
  it('returns to home when viewing the deleted integration', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'chat', integrationId: 'i1' }))
    act(() => result.current.handleChatIntegrationDeleted('i1'))
    expect(result.current.view).toEqual({ kind: 'home' })
  })

  it('returns to home when viewing a chat session within the deleted integration', () => {
    const { result } = setup()
    act(() =>
      result.current.setAgent('agent-1', {
        kind: 'chat',
        integrationId: 'i1',
        sessionId: 'cs1',
      })
    )
    act(() => result.current.handleChatIntegrationDeleted('i1'))
    expect(result.current.view).toEqual({ kind: 'home' })
  })

  it('does nothing when a different integration is being viewed', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'chat', integrationId: 'i1' }))
    act(() => result.current.handleChatIntegrationDeleted('i2'))
    expect(result.current.view).toEqual({ kind: 'chat', integrationId: 'i1' })
  })
})

describe('SelectionContext — handleDashboardDeleted', () => {
  it('returns to home when viewing the deleted dashboard', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'dashboard', slug: 'd1' }))
    act(() => result.current.handleDashboardDeleted('d1'))
    expect(result.current.view).toEqual({ kind: 'home' })
  })

  it('does nothing when a different dashboard is being viewed', () => {
    const { result } = setup()
    act(() => result.current.setAgent('agent-1', { kind: 'dashboard', slug: 'd1' }))
    act(() => result.current.handleDashboardDeleted('d2'))
    expect(result.current.view).toEqual({ kind: 'dashboard', slug: 'd1' })
  })
})

describe('SelectionContext — chat session navigation', () => {
  // Within an integration the user can navigate between chat sessions; the
  // sessionId field must update without churning the integrationId.
  it('switching between chat sessions keeps the integration id', () => {
    const { result } = setup()
    act(() =>
      result.current.setAgent('agent-1', {
        kind: 'chat',
        integrationId: 'i1',
        sessionId: 'cs1',
      })
    )
    act(() =>
      result.current.setView({ kind: 'chat', integrationId: 'i1', sessionId: 'cs2' })
    )
    expect(result.current.view).toEqual({
      kind: 'chat',
      integrationId: 'i1',
      sessionId: 'cs2',
    })
  })

  it('selecting an integration without a session id drops any prior session id', () => {
    const { result } = setup()
    act(() =>
      result.current.setAgent('agent-1', {
        kind: 'chat',
        integrationId: 'i1',
        sessionId: 'cs1',
      })
    )
    act(() => result.current.setView({ kind: 'chat', integrationId: 'i1' }))
    expect(result.current.view).toEqual({ kind: 'chat', integrationId: 'i1' })
  })
})

describe('SelectionContext — function identity stability', () => {
  // Setters must be stable across re-renders so consumers can put them in
  // useEffect dep arrays without triggering loops.
  it('setAgent / setView / clearSelection are stable references', () => {
    const { result, rerender } = renderHook(() => useSelection(), { wrapper })
    const first = {
      setAgent: result.current.setAgent,
      setView: result.current.setView,
      clearSelection: result.current.clearSelection,
      setAgentWithDraft: result.current.setAgentWithDraft,
      handleAgentDeleted: result.current.handleAgentDeleted,
      handleSessionDeleted: result.current.handleSessionDeleted,
      handleScheduledTaskDeleted: result.current.handleScheduledTaskDeleted,
      handleWebhookTriggerDeleted: result.current.handleWebhookTriggerDeleted,
      handleChatIntegrationDeleted: result.current.handleChatIntegrationDeleted,
      handleDashboardDeleted: result.current.handleDashboardDeleted,
    }
    rerender()
    // After a state change, the setters should still be the same references.
    act(() => result.current.setAgent('agent-1'))
    expect(result.current.setAgent).toBe(first.setAgent)
    expect(result.current.setView).toBe(first.setView)
    expect(result.current.clearSelection).toBe(first.clearSelection)
    expect(result.current.setAgentWithDraft).toBe(first.setAgentWithDraft)
    expect(result.current.handleAgentDeleted).toBe(first.handleAgentDeleted)
    expect(result.current.handleSessionDeleted).toBe(first.handleSessionDeleted)
    expect(result.current.handleScheduledTaskDeleted).toBe(first.handleScheduledTaskDeleted)
    expect(result.current.handleWebhookTriggerDeleted).toBe(first.handleWebhookTriggerDeleted)
    expect(result.current.handleChatIntegrationDeleted).toBe(first.handleChatIntegrationDeleted)
    expect(result.current.handleDashboardDeleted).toBe(first.handleDashboardDeleted)
  })
})
