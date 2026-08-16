import { describe, it, expect } from 'vitest'
import {
  findDeltaWindowStart,
  pickDeltaAnchor,
  mergeDeltaMessages,
  type DeltaWindowItem,
} from './messages-delta'

function user(id: string, queued = false): DeltaWindowItem {
  return { id, type: 'user', ...(queued ? { queued: true } : {}) }
}

function assistant(id: string, opts?: { open?: number; closed?: number }): DeltaWindowItem {
  const toolCalls: Array<{ result?: unknown }> = []
  for (let i = 0; i < (opts?.closed ?? 0); i++) toolCalls.push({ result: 'ok' })
  for (let i = 0; i < (opts?.open ?? 0); i++) toolCalls.push({})
  return { id, type: 'assistant', toolCalls }
}

function informational(id: string): DeltaWindowItem {
  return { id, type: 'informational' }
}

describe('findDeltaWindowStart / pickDeltaAnchor', () => {
  it('marks the trailing assistant message volatile even with no tool calls (it may still merge streamed blocks)', () => {
    const items = [user('u1'), assistant('a1'), user('u2'), assistant('a2')]
    expect(findDeltaWindowStart(items)).toBe(3)
    expect(pickDeltaAnchor(items)).toBe('u2')
  })

  it('anchors on the last user message when it is the last item (turn just started)', () => {
    const items = [user('u1'), assistant('a1'), user('u2')]
    expect(findDeltaWindowStart(items)).toBe(3)
    expect(pickDeltaAnchor(items)).toBe('u2')
  })

  it('starts the window at the first open tool call of the live turn', () => {
    const items = [
      user('u1'),
      assistant('a1', { open: 1 }),
      assistant('a2'),
      assistant('a3', { closed: 1 }),
    ]
    expect(findDeltaWindowStart(items)).toBe(1)
    expect(pickDeltaAnchor(items)).toBe('u1')
  })

  it('ignores open tool calls from finished turns (a non-queued user message ends the turn)', () => {
    // a1's call was interrupted — its result can never arrive once u2 started a
    // new turn — so it must not drag the anchor back forever.
    const items = [
      user('u1'),
      assistant('a1', { open: 1 }),
      user('u2'),
      assistant('a2', { closed: 2 }),
      user('u3'),
      assistant('a3'),
    ]
    expect(findDeltaWindowStart(items)).toBe(5)
    expect(pickDeltaAnchor(items)).toBe('u3')
  })

  it('a queued user message does not end the turn: open calls before it stay volatile', () => {
    const items = [user('u1'), assistant('a1', { open: 1 }), user('uq', true)]
    expect(findDeltaWindowStart(items)).toBe(1)
    expect(pickDeltaAnchor(items)).toBe('u1')
  })

  it('trailing system items do not shield the still-merging assistant before them', () => {
    const items = [user('u1'), assistant('a1'), informational('i1')]
    expect(findDeltaWindowStart(items)).toBe(1)
    expect(pickDeltaAnchor(items)).toBe('u1')
  })

  it('returns null when nothing is safely settled yet', () => {
    expect(pickDeltaAnchor([assistant('a1', { open: 1 })])).toBeNull()
    expect(pickDeltaAnchor([assistant('a1')])).toBeNull()
    expect(pickDeltaAnchor([])).toBeNull()
  })

  it('settled assistant items with all results present are only volatile when trailing', () => {
    const items = [user('u1'), assistant('a1', { closed: 2 }), user('u2'), assistant('a2', { closed: 1 })]
    // a2 is trailing (may still merge); a1 is settled history.
    expect(findDeltaWindowStart(items)).toBe(3)
    expect(pickDeltaAnchor(items)).toBe('u2')
  })
})

describe('mergeDeltaMessages', () => {
  const m = (id: string, text = '') => ({ id, text })

  it('appends new items after the anchor', () => {
    const merged = mergeDeltaMessages([m('a'), m('b')], [m('b'), m('c'), m('d')])
    expect(merged?.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('upserts: the delta version of an item the client already holds wins', () => {
    const merged = mergeDeltaMessages(
      [m('a'), m('b', 'stale'), m('c', 'stale')],
      [m('b', 'fresh'), m('c', 'fresh')]
    )
    expect(merged).toEqual([m('a'), m('b', 'fresh'), m('c', 'fresh')])
  })

  it('drops cached suffix items the window no longer contains (rewritten away)', () => {
    const merged = mergeDeltaMessages([m('a'), m('b'), m('gone'), m('c')], [m('b'), m('c')])
    expect(merged?.map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns null when the window start is unknown to the cache (caller must full-fetch)', () => {
    expect(mergeDeltaMessages([m('a'), m('b')], [m('x'), m('y')])).toBeNull()
  })

  it('an empty delta leaves the cache unchanged', () => {
    expect(mergeDeltaMessages([m('a')], [])).toEqual([m('a')])
  })
})
