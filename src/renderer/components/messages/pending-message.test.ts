import { describe, it, expect } from 'vitest'
import { isTurnStartingPendingMessage } from './pending-message'

describe('isTurnStartingPendingMessage', () => {
  const pending = { localId: 'l1', uuid: 'u1', text: 'hi', sentAt: 1000, afterMessageId: 'anchor' }
  const anchor = { id: 'anchor', type: 'assistant' }

  it('starts a turn until a turn-starting user message sits after its anchor, then is stranded', () => {
    expect(isTurnStartingPendingMessage(pending, [{ id: 'older', type: 'user' }, anchor])).toBe(true)
    expect(isTurnStartingPendingMessage(pending, [anchor, { id: 'next', type: 'user' }])).toBe(false)
    // The previous turn's final answer, or a queued message, landing after a quick follow-up's anchor
    expect(isTurnStartingPendingMessage(pending, [anchor, { id: 'final', type: 'assistant' }])).toBe(true)
    expect(isTurnStartingPendingMessage(pending, [anchor, { id: 'q', type: 'user', queued: true }])).toBe(true)
    // Other entry types (a compact boundary) do not strand it
    expect(isTurnStartingPendingMessage(pending, [anchor, { id: 'b', type: 'compact_boundary' }])).toBe(true)
    // No anchor (empty, or not loaded yet at send): every loaded message is later
    const unanchored = { ...pending, afterMessageId: undefined }
    expect(isTurnStartingPendingMessage(unanchored, [])).toBe(true)
    expect(isTurnStartingPendingMessage(unanchored, [{ id: 'next', type: 'user' }])).toBe(false)
    // An anchor paged out behind later messages: every loaded message is later
    expect(isTurnStartingPendingMessage(pending, [{ id: 'next', type: 'user' }])).toBe(false)
    // Queued messages never start a turn
    expect(isTurnStartingPendingMessage({ ...pending, queued: true }, [anchor])).toBe(false)
  })
})
