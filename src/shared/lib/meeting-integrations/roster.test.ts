import { describe, expect, it } from 'vitest'
import { MEETING_ROSTER_IDLE_TTL_MS, MeetingRosterStore } from './roster'

const iddo = { id: '1', name: 'Iddo', isHost: true }
const maya = { id: '2', name: 'Maya', isHost: false }

describe('MeetingRosterStore', () => {
  it('tracks who is in the room and who is speaking, never the bot itself', () => {
    const store = new MeetingRosterStore()
    store.apply('m', { kind: 'join', participant: iddo }, 'Ada')
    store.apply('m', { kind: 'join', participant: { id: '9', name: 'ada', isHost: false } }, 'Ada')
    store.apply('m', { kind: 'speech_on', participant: maya }, 'Ada')
    expect(store.get('m')).toEqual({ participants: [iddo, maya], speaking: ['2'] })
    store.apply('m', { kind: 'speech_off', participant: maya }, 'Ada')
    store.apply('m', { kind: 'leave', participant: iddo }, 'Ada')
    expect(store.get('m')).toEqual({ participants: [maya], speaking: [] })
    expect(store.get('other')).toEqual({ participants: [], speaking: [] })
  })

  it('notifies subscribers on every change and on clear, then forgets the room', () => {
    const store = new MeetingRosterStore()
    const seen: number[] = []
    const unsubscribe = store.subscribe('m', roster => seen.push(roster.participants.length))
    store.apply('m', { kind: 'join', participant: iddo }, 'Ada')
    store.apply('m', { kind: 'join', participant: maya }, 'Ada')
    store.clear('m')
    expect(seen).toEqual([1, 2, 0])
    expect(store.size()).toBe(0)
    unsubscribe()
  })

  it('drops rooms nobody watches once they have been idle past the TTL', () => {
    let now = 1_000_000
    const store = new MeetingRosterStore(() => now)
    // A late webhook for a meeting the host no longer tracks creates a room with no listeners.
    store.apply('stale', { kind: 'join', participant: iddo }, 'Ada')
    // A watched room stays however long it is quiet.
    const unsubscribe = store.subscribe('watched', () => {})
    store.apply('watched', { kind: 'join', participant: maya }, 'Ada')
    now += MEETING_ROSTER_IDLE_TTL_MS + 1
    store.apply('fresh', { kind: 'join', participant: iddo }, 'Ada')
    expect(store.get('stale').participants).toEqual([])
    expect(store.get('watched').participants).toEqual([maya])
    expect(store.get('fresh').participants).toEqual([iddo])
    expect(store.size()).toBe(2)
    unsubscribe()
  })
})
