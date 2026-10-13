import { describe, expect, it, vi } from 'vitest'
import { getRecentPowerEvents, recordPowerEvent } from './power-events'

describe('power events', () => {
  it('keeps the last ten sleep/wake transitions in order', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-13T17:00:00.000Z'))
      for (let i = 0; i < 12; i++) {
        recordPowerEvent(i % 2 === 0 ? 'suspend' : 'resume')
        vi.advanceTimersByTime(60_000)
      }
      const events = getRecentPowerEvents()
      expect(events).toHaveLength(10)
      expect(events[0]).toEqual({ type: 'suspend', at: '2026-10-13T17:02:00.000Z' })
      expect(events[9]).toEqual({ type: 'resume', at: '2026-10-13T17:11:00.000Z' })
    } finally {
      vi.useRealTimers()
    }
  })
})
