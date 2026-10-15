// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { formatLastRun } from '@renderer/lib/last-run'
import { useMinuteClock } from './use-minute-clock'

function Label({ date }: { date: string }) {
  useMinuteClock()
  return <span>{formatLastRun(date)}</span>
}

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-09T12:00:00Z') }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('shares one interval and removes it when the last label unmounts', () => {
  const intervals = vi.spyOn(globalThis, 'setInterval')
  const first = render(<Label date="2026-10-09T09:00:00Z" />)
  const second = render(<Label date="2026-10-09T10:00:00Z" />)
  expect(intervals).toHaveBeenCalledTimes(1)
  act(() => vi.advanceTimersByTime(60 * 60 * 1000))
  expect(screen.getByText('Last run about 4 hours ago')).toBeInTheDocument()
  expect(screen.getByText('Last run about 3 hours ago')).toBeInTheDocument()
  first.unmount()
  expect(vi.getTimerCount()).toBe(1)
  second.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('uses the current time for new activity arriving between ticks', () => {
  const { rerender } = render(<Label date="2026-10-09T09:00:00Z" />)
  act(() => vi.advanceTimersByTime(45_000))
  rerender(<Label date="2026-10-09T12:00:45Z" />)
  expect(screen.getByText('Last run less than a minute ago')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(75_000))
  expect(screen.getByText('Last run 1 minute ago')).toBeInTheDocument()
})

it('stops in the background and catches up immediately when the page returns', () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  render(<Label date="2026-10-09T09:00:00Z" />)
  act(() => {
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(60 * 60 * 1000)
  })
  expect(vi.getTimerCount()).toBe(0)
  expect(screen.getByText('Last run about 3 hours ago')).toBeInTheDocument()
  act(() => {
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(screen.getByText('Last run about 4 hours ago')).toBeInTheDocument()
  expect(vi.getTimerCount()).toBe(1)
})
