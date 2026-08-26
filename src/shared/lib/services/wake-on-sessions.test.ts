import { describe, it, expect } from 'vitest'
import { openTargets, parseWakeOnSessions, serializeWakeOnSessions } from './wake-on-sessions'

describe('wake-on-sessions', () => {
  it('round-trips a value', () => {
    const value = {
      targets: [
        { agentSlug: 'b', sessionId: 's-b', boundaryUuid: 'u1' },
        { agentSlug: 'c', sessionId: 's-c', outcome: 'completed' as const },
      ],
      deferredTimerAt: '2026-09-01T09:00:00.000Z',
    }
    expect(parseWakeOnSessions(serializeWakeOnSessions(value))).toEqual(value)
  })

  it('returns null for null, malformed JSON, a wrong shape, and a non-ISO timer', () => {
    expect(parseWakeOnSessions(null)).toBeNull()
    expect(parseWakeOnSessions('{')).toBeNull()
    expect(parseWakeOnSessions('{"targets":[{"agentSlug":1}]}')).toBeNull()
    expect(parseWakeOnSessions('{"targets":[],"deferredTimerAt":"tomorrow"}')).toBeNull()
  })

  it('serialize validates before writing', () => {
    expect(() => serializeWakeOnSessions({ targets: [], deferredTimerAt: 'tomorrow' })).toThrow()
  })

  it('openTargets returns only entries without an outcome', () => {
    const value = parseWakeOnSessions('{"targets":[{"agentSlug":"b","sessionId":"1"},{"agentSlug":"c","sessionId":"2","outcome":"errored"}]}')!
    expect(openTargets(value).map((t) => t.sessionId)).toEqual(['1'])
  })
})
