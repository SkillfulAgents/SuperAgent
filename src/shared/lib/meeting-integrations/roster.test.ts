import { afterEach, describe, expect, it, vi } from 'vitest'
import { appState, type StateKey } from '../app-state'
import { backgroundSettled } from '../background'
import {
  MEETING_ROSTER_ENDED_TTL_MS, MEETING_ROSTER_HEARTBEAT_MS, MEETING_ROSTER_IDLE_TTL_MS,
  meetingRoster, meetingRosterChannel, meetingRosterKey,
} from './roster'
import type { MeetingParticipant, MeetingRoster } from './schemas'

const iddo = { id: '1', name: 'Iddo', isHost: true }
const maya = { id: '2', name: 'Maya', isHost: false }
const join = (participant: MeetingParticipant) => ({ kind: 'join' as const, participant })
const empty: MeetingRoster = { participants: [], speaking: [] }
const names = (roster: MeetingRoster) => roster.participants.map(person => person.name)
const person = (index: number) => ({ id: String(index), name: `Person ${index}`, isHost: false })

/** Runs `work` after `ticks` turns of the microtask queue, to land it at every point of a race. */
async function after<T>(ticks: number, work: () => Promise<T>): Promise<T> {
  for (let tick = 0; tick < ticks; tick++) await Promise.resolve()
  return work()
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('meetingRoster', () => {
  it('tracks who is in the room and who is speaking, never the bot itself', async () => {
    await meetingRoster.apply('m', join(iddo), 'Ada')
    await meetingRoster.apply('m', join({ id: '9', name: ' ada ', isHost: false }), 'Ada')
    await meetingRoster.apply('m', { kind: 'speech_on', participant: maya }, 'Ada')
    expect(await meetingRoster.get('m')).toEqual({ participants: [iddo, maya], speaking: ['2'] })
    await meetingRoster.apply('m', { kind: 'update', participant: { ...maya, name: 'Maya K' } }, 'Ada')
    await meetingRoster.apply('m', { kind: 'speech_off', participant: maya }, 'Ada')
    await meetingRoster.apply('m', { kind: 'leave', participant: iddo }, 'Ada')
    expect(await meetingRoster.get('m')).toEqual({ participants: [{ ...maya, name: 'Maya K' }], speaking: [] })
    expect(await meetingRoster.get('other')).toEqual(empty)
  })

  it('writes nothing for an event that changes nothing', async () => {
    await meetingRoster.apply('m', join(iddo), 'Ada')
    const before = await appState().get(meetingRosterKey('m'))
    await meetingRoster.apply('m', join(iddo), 'Ada')
    await meetingRoster.apply('m', { kind: 'speech_off', participant: iddo }, 'Ada')
    await meetingRoster.apply('m', join({ id: '9', name: 'Ada', isHost: false }), 'Ada')
    expect((await appState().get(meetingRosterKey('m')))?.revision).toBe(before?.revision)
  })

  it('loses no participant when many callbacks land at once', async () => {
    const everyone = Array.from({ length: 30 }, (_, index) => person(index))
    await Promise.all(everyone.map(participant => meetingRoster.apply('m', join(participant), 'Ada')))
    const roster = await meetingRoster.get('m')
    expect(roster.participants).toHaveLength(30)
    expect(new Set(roster.participants.map(participant => participant.id))).toEqual(new Set(everyone.map(participant => participant.id)))
    expect((await appState().get(meetingRosterKey('m')))?.value.revision).toBe(30)
  })

  it('applies its change again to what is stored when another write lands between its read and its write', async () => {
    const state = appState()
    const read = state.get.bind(state)
    vi.spyOn(state, 'get').mockImplementationOnce((async (key: StateKey<unknown>) => {
      const entry = await read(key)
      // Another callback lands after this read and before its compare-and-set.
      await meetingRoster.apply('m', join(maya), 'Ada')
      return entry
    }) as typeof state.get)
    await meetingRoster.apply('m', join(iddo), 'Ada')
    expect(names(await meetingRoster.get('m')).sort()).toEqual(['Iddo', 'Maya'])
  })

  it('hands a watcher the roster now and each change after, and nothing once it stopped', async () => {
    await meetingRoster.apply('m', join(iddo), 'Ada')
    const seen: string[][] = []
    const watch = await meetingRoster.watch('m', roster => seen.push(names(roster)))
    expect(seen).toEqual([['Iddo']])
    await meetingRoster.apply('m', join(maya), 'Ada')
    await backgroundSettled()
    expect(seen).toEqual([['Iddo'], ['Iddo', 'Maya']])
    await watch.stop()
    await meetingRoster.apply('m', { kind: 'leave', participant: iddo }, 'Ada')
    await backgroundSettled()
    expect(seen).toEqual([['Iddo'], ['Iddo', 'Maya']])
    await watch.stop()
  })

  it('misses no change that lands while a watcher is setting up, wherever it lands', async () => {
    for (let ticks = 0; ticks < 40; ticks++) {
      const meetingId = `m-${ticks}`
      await meetingRoster.apply(meetingId, join(iddo), 'Ada')
      const seen: string[][] = []
      const [watch] = await Promise.all([
        meetingRoster.watch(meetingId, roster => seen.push(names(roster))),
        after(ticks, () => meetingRoster.apply(meetingId, join(maya), 'Ada')),
      ])
      await backgroundSettled()
      // The join is in the first roster or the next one; never shown twice, never stepped back from.
      expect(seen, `a join ${ticks} ticks into the watch`).toEqual(seen[0].length === 2 ? [['Iddo', 'Maya']] : [['Iddo'], ['Iddo', 'Maya']])
      await watch.stop()
    }
  })

  it('reads again after a slow read during which a change was announced', async () => {
    await meetingRoster.apply('m', join(iddo), 'Ada')
    const seen: string[][] = []
    const watch = await meetingRoster.watch('m', roster => seen.push(names(roster)))
    const state = appState()
    const read = state.get.bind(state)
    vi.spyOn(state, 'get').mockImplementationOnce((async (key: StateKey<unknown>) => {
      const entry = await read(key)
      // A remote read takes a round trip: a change lands and is announced before this answer arrives.
      await meetingRoster.apply('m', join(maya), 'Ada')
      await new Promise(resolve => setTimeout(resolve, 0))
      return entry
    }) as typeof state.get)
    // Any hint for a roster it does not show starts the slow read.
    await appState().publish(meetingRosterChannel('m'), { incarnation: 'another', revision: 99 })
    await vi.waitFor(() => expect(seen).toEqual([['Iddo'], ['Iddo', 'Maya']]))
    await backgroundSettled()
    expect(seen).toEqual([['Iddo'], ['Iddo', 'Maya']])
    await watch.stop()
  })

  it('drops a hint for the roster it already shows, and catches up on a lost hint at its heartbeat', async () => {
    vi.useFakeTimers()
    await meetingRoster.apply('m', join(iddo), 'Ada')
    const seen: string[][] = []
    const watch = await meetingRoster.watch('m', roster => seen.push(names(roster)))
    const key = meetingRosterKey('m')
    const stored = (await appState().get(key))!
    await appState().publish(meetingRosterChannel('m'), { incarnation: stored.value.incarnation, revision: stored.value.revision })
    await backgroundSettled()
    expect(seen).toEqual([['Iddo']])
    // A change whose hint never arrives (written here without one).
    await appState().compareAndSet(key, stored.revision, { ...stored.value, participantsById: { ...stored.value.participantsById, [maya.id]: maya }, revision: stored.value.revision + 1 })
    await backgroundSettled()
    expect(seen).toEqual([['Iddo']])
    await vi.advanceTimersByTimeAsync(MEETING_ROSTER_HEARTBEAT_MS)
    await backgroundSettled()
    expect(seen).toEqual([['Iddo'], ['Iddo', 'Maya']])
    await watch.stop()
  })

  it('shows a roster that expired while its watcher was suspended and came back counting from the start again', async () => {
    vi.useFakeTimers()
    await meetingRoster.apply('m', join(iddo), 'Ada')
    const seen: string[][] = []
    const watch = await meetingRoster.watch('m', roster => seen.push(names(roster)))
    expect(seen).toEqual([['Iddo']])
    // The process sleeps through its heartbeats (a suspended laptop): the clock jumps, no timer runs.
    vi.setSystemTime(Date.now() + MEETING_ROSTER_IDLE_TTL_MS + 1)
    expect(await appState().get(meetingRosterKey('m'))).toBeNull()
    // A callback starts a new roster, whose first change has the same count as the one shown.
    await meetingRoster.apply('m', join(maya), 'Ada')
    expect((await appState().get(meetingRosterKey('m')))?.value.revision).toBe(1)
    await backgroundSettled()
    expect(seen).toEqual([['Iddo'], ['Maya']])
    // Again, with the new roster's hint lost: the next heartbeat's read catches it.
    vi.setSystemTime(Date.now() + MEETING_ROSTER_IDLE_TTL_MS + 1)
    const restarted = { participantsById: { [iddo.id]: iddo }, speakingIds: [], touchedAt: Date.now(), revision: 1, incarnation: 'restarted', ended: false }
    expect((await appState().compareAndSet(meetingRosterKey('m'), null, restarted)).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(MEETING_ROSTER_HEARTBEAT_MS)
    await backgroundSettled()
    expect(seen).toEqual([['Iddo'], ['Maya'], ['Iddo']])
    await watch.stop()
  })

  it('keeps a watched roster live however quiet the call, and forgets one nobody watches after four idle hours', async () => {
    vi.useFakeTimers()
    // A late webhook for a meeting the host no longer tracks starts a roster nobody watches.
    await meetingRoster.apply('stale', join(iddo), 'Ada')
    const watch = await meetingRoster.watch('watched', () => {})
    await meetingRoster.apply('watched', join(maya), 'Ada')
    await vi.advanceTimersByTimeAsync(MEETING_ROSTER_IDLE_TTL_MS - 1)
    // Any change restarts the idle lifetime.
    await meetingRoster.apply('stale', join(maya), 'Ada')
    await vi.advanceTimersByTimeAsync(MEETING_ROSTER_IDLE_TTL_MS - 1)
    expect(names(await meetingRoster.get('stale'))).toEqual(['Iddo', 'Maya'])
    await vi.advanceTimersByTimeAsync(1)
    expect(await meetingRoster.get('stale')).toEqual(empty)
    // Eight quiet hours on, the watched call still has its roster.
    expect(names(await meetingRoster.get('watched'))).toEqual(['Maya'])
    await watch.stop()
  })

  it('gives a roster about to expire a full lifetime when a watcher arrives', async () => {
    vi.useFakeTimers()
    await meetingRoster.apply('m', join(iddo), 'Ada')
    await vi.advanceTimersByTimeAsync(MEETING_ROSTER_IDLE_TTL_MS - 1000)
    const watch = await meetingRoster.watch('m', () => {})
    await vi.advanceTimersByTimeAsync(MEETING_ROSTER_HEARTBEAT_MS - 1)
    expect(names(await meetingRoster.get('m'))).toEqual(['Iddo'])
    await watch.stop()
  })

  it('stops its heartbeat when the watcher stops, so the idle lifetime runs out', async () => {
    vi.useFakeTimers()
    const timers = vi.getTimerCount()
    const onRoster = vi.fn()
    const watch = await meetingRoster.watch('m', onRoster)
    expect(vi.getTimerCount()).toBe(timers + 1)
    await meetingRoster.apply('m', join(iddo), 'Ada')
    await vi.advanceTimersByTimeAsync(MEETING_ROSTER_IDLE_TTL_MS)
    expect(names(await meetingRoster.get('m'))).toEqual(['Iddo'])
    await watch.stop()
    expect(vi.getTimerCount()).toBe(timers)
    await vi.advanceTimersByTimeAsync(MEETING_ROSTER_IDLE_TTL_MS + 1)
    expect(await meetingRoster.get('m')).toEqual(empty)
    expect(onRoster.mock.calls.map(([roster]) => names(roster))).toEqual([[], ['Iddo']])
  })

  it('ends the roster when the call ends: watchers see it empty and a late callback does not bring it back', async () => {
    vi.useFakeTimers()
    await meetingRoster.apply('m', join(iddo), 'Ada')
    const live = await appState().get(meetingRosterKey('m'))
    const seen: string[][] = []
    const watch = await meetingRoster.watch('m', roster => seen.push(names(roster)))
    await meetingRoster.clear('m')
    await backgroundSettled()
    expect(seen).toEqual([['Iddo'], []])
    // A callback that read the meeting as live just before it ended.
    await meetingRoster.apply('m', join(maya), 'Ada')
    await meetingRoster.clear('m')
    await backgroundSettled()
    expect(await meetingRoster.get('m')).toEqual(empty)
    expect(seen).toEqual([['Iddo'], []])
    const ended = await appState().get(meetingRosterKey('m'))
    expect(ended?.value.ended).toBe(true)
    expect(ended?.value.incarnation).not.toBe(live?.value.incarnation)
    expect(ended?.expiresAt).toBe(Date.now() + MEETING_ROSTER_ENDED_TTL_MS)
    // The ended roster expires though a watcher is still there: its heartbeat keeps live calls only.
    await vi.advanceTimersByTimeAsync(MEETING_ROSTER_ENDED_TTL_MS)
    expect(await appState().get(meetingRosterKey('m'))).toBeNull()
    await watch.stop()
  })

  it('ends a roster that never started, and the end wins over callbacks racing it', async () => {
    await meetingRoster.clear('quiet')
    await meetingRoster.apply('quiet', join(iddo), 'Ada')
    expect(await meetingRoster.get('quiet')).toEqual(empty)

    const everyone = Array.from({ length: 20 }, (_, index) => person(index))
    await Promise.all([
      ...everyone.slice(0, 10).map(participant => meetingRoster.apply('busy', join(participant), 'Ada')),
      meetingRoster.clear('busy'),
      ...everyone.slice(10).map(participant => meetingRoster.apply('busy', join(participant), 'Ada')),
    ])
    expect(await meetingRoster.get('busy')).toEqual(empty)
    expect((await appState().get(meetingRosterKey('busy')))?.value.ended).toBe(true)
  })
})
