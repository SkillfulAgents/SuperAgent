import { describe, expect, it } from 'vitest'
import type { ApiSession } from '@shared/lib/types/api'
import { teamBrainSessions } from './team-brain-sessions'

const session = (id: string, extra: Partial<ApiSession> = {}): ApiSession => ({
  id, agentSlug: 'team-brain', name: id, createdAt: new Date(), lastActivityAt: new Date(), ...extra,
})

describe('teamBrainSessions', () => {
  it('keeps human chats and a scheduled run only while it waits for input', () => {
    const chat = session('person', { origin: 'user' })
    const run = session('sync', { origin: 'scheduled', isActive: true, isAwaitingInput: true })
    expect(teamBrainSessions([chat, run])).toEqual([chat, run])
    expect(teamBrainSessions([chat, { ...run, isAwaitingInput: false }])).toEqual([chat])
  })

  it.each(['webhook', 'integration', 'agent', 'widget-repair'] as const)(
    'leaves promoted %s sessions out even while they await input', (origin) => {
      const chat = session('person', { origin: 'user' })
      expect(teamBrainSessions([chat, session('automated', { origin, isAwaitingInput: true })])).toEqual([chat])
    },
  )

  it('accepts an older server response without origin', () => {
    const chat = session('person')
    expect(teamBrainSessions([chat])).toEqual([chat])
  })
})
