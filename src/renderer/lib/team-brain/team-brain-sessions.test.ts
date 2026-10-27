import { describe, expect, it } from 'vitest'
import type { ApiSession } from '@shared/lib/types/api'
import type { AutomationSessionInfo } from '@renderer/hooks/use-agent-automations'
import { recentSessions } from './team-brain-sessions'

const HOUR = 3_600_000
const at = (hoursAgo: number) => new Date(Date.UTC(2026, 9, 27, 12) - hoursAgo * HOUR).toISOString()

/** A session as the agent's list returns it, its dates as JSON strings. */
const chat = (id: string, hoursAgo: number, extra: Partial<ApiSession> = {}) =>
  ({ id, agentSlug: 'team-brain', name: id, createdAt: at(hoursAgo + 1), lastActivityAt: at(hoursAgo), ...extra }) as unknown as ApiSession
const run = (id: string, hoursAgo: number, isAwaitingInput = false): AutomationSessionInfo => ({ id, name: id, createdAt: at(hoursAgo + 1), lastActivityAt: at(hoursAgo), isAwaitingInput })

describe('recentSessions', () => {
  it('shows the three most recent a person started, newest first', () => {
    const chats = [chat('a', 5), chat('b', 1), chat('c', 3), chat('d', 2), chat('e', 4)]
    expect(recentSessions(chats, []).map((s) => s.id)).toEqual(['b', 'd', 'c'])
  })

  it('leaves out other agents messaging Team Brain, webhooks and widget repairs', () => {
    const chats = [
      chat('person', 4),
      chat('from-agent', 1, { invokedByAgentSlug: 'writer' }),
      chat('webhook', 2, { webhookTriggerId: 'w1' }),
      chat('repair', 3, { isWidgetRepair: true }),
    ]
    expect(recentSessions(chats, []).map((s) => s.id)).toEqual(['person'])
  })

  it('adds a scheduled run only while it waits on someone, ahead of the rest', () => {
    const chats = [chat('a', 1), chat('b', 2), chat('c', 3), chat('d', 4)]
    const runs = [run('sync-waiting', 9, true), run('sync-done', 0)]
    const recent = recentSessions(chats, runs)
    expect(recent.map((s) => s.id)).toEqual(['sync-waiting', 'a', 'b'])
    expect(recent[0].isAwaitingInput).toBe(true)
  })

  it('lists a session once, and a chat waiting on someone first too', () => {
    const chats = [chat('a', 1), chat('b', 5, { isAwaitingInput: true })]
    expect(recentSessions(chats, [run('a', 1, true)]).map((s) => s.id)).toEqual(['b', 'a'])
  })
})
