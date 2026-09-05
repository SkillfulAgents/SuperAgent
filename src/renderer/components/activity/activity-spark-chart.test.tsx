// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ActivitySparkChart, CronSparkChart } from './activity-spark-chart'

describe('activity spark charts', () => {
  it('renders stacked daily volume with a useful accessible summary', () => {
    render(<ActivitySparkChart
      label="GitHub activity"
      data={[
        { date: '2026-07-07', succeeded: 0, failed: 0 },
        { date: '2026-07-08', succeeded: 3, failed: 1 },
        { date: '2026-07-09', succeeded: 2, failed: 0 },
      ]}
    />)

    expect(screen.getByRole('img', {
      name: 'GitHub activity: 6 calls over 3 days, 5 succeeded and 1 failed.',
    })).toBeInTheDocument()
    expect(screen.getAllByTestId('activity-success-bar')).toHaveLength(3)
    expect(screen.getAllByTestId('activity-failure-bar')).toHaveLength(3)
    expect(screen.queryByTestId('spark-tooltip')).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getAllByTestId('spark-hit')[1])
    const tip = screen.getByTestId('spark-tooltip')
    expect(tip).toHaveTextContent('Jul 8')
    expect(tip).toHaveTextContent('3 Succeeded')
    expect(tip).toHaveTextContent('1 Failed')
  })

  it('draws a track per day so an empty window still reads as 14 days', () => {
    render(<ActivitySparkChart
      label="GitHub activity"
      data={Array.from({ length: 14 }, (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`, succeeded: 0, failed: 0,
      }))}
    />)

    expect(screen.getAllByTestId('activity-day-track')).toHaveLength(14)
    // Nothing ran, so no segment has height.
    for (const bar of screen.getAllByTestId('activity-success-bar')) {
      expect(bar).toHaveAttribute('height', '0')
    }
  })

  it('floors a lone call so it cannot render as a sub-pixel sliver', () => {
    render(<ActivitySparkChart
      label="GitHub activity"
      data={[
        { date: '2026-07-08', succeeded: 500, failed: 0 },
        { date: '2026-07-09', succeeded: 1, failed: 0 },
      ]}
    />)

    const [tall, lone] = screen.getAllByTestId('activity-success-bar')
    expect(Number(tall.getAttribute('height'))).toBeGreaterThan(10)
    // 1/500 of the track would be ~0.04px; the floor keeps it visible.
    expect(Number(lone.getAttribute('height'))).toBeGreaterThanOrEqual(1.5)
  })

  it('squares the edge where a day\'s success and failure segments meet', () => {
    render(<ActivitySparkChart
      label="GitHub activity"
      data={[
        { date: '2026-07-08', succeeded: 6, failed: 3 },
        { date: '2026-07-09', succeeded: 6, failed: 0 },
      ]}
    />)

    const [stackedOk, loneOk] = screen.getAllByTestId('activity-success-bar')
    const [stackedFail] = screen.getAllByTestId('activity-failure-bar')

    // Stacked: paths, so only the outer edge of each segment is rounded.
    expect(stackedOk.tagName).toBe('path')
    expect(stackedFail.tagName).toBe('path')
    // A day with no failures keeps the plain fully-rounded rect.
    expect(loneOk.tagName).toBe('rect')
    expect(loneOk).toHaveAttribute('rx')

    // Both paths begin at the join with a straight move, so the success
    // segment's top and the failure segment's bottom are one flat line.
    const startY = (el: Element) =>
      Number(el.getAttribute('d')!.match(/^M[\d.]+,([\d.]+) /)![1])
    expect(startY(stackedOk)).toBeCloseTo(startY(stackedFail), 5)

    // And each keeps exactly one rounded end: two quadratic curves, not four.
    expect(stackedOk.getAttribute('d')!.match(/Q/g)).toHaveLength(2)
    expect(stackedFail.getAttribute('d')!.match(/Q/g)).toHaveLength(2)
  })

  it('keeps an all-zero series visible and truthful', () => {
    render(<ActivitySparkChart
      label="Slack activity"
      data={[
        { date: '2026-07-08', succeeded: 0, failed: 0 },
        { date: '2026-07-09', succeeded: 0, failed: 0 },
      ]}
    />)

    expect(screen.getByRole('img', {
      name: 'Slack activity: no calls over the last 2 days.',
    })).toBeInTheDocument()
  })

  it('renders cron outcomes with status colors and an accessible summary', () => {
    render(<CronSparkChart
      label="Nightly report schedule"
      data={[
        { scheduledAt: '2026-07-07T09:00:00.000Z', status: 'succeeded' },
        { scheduledAt: '2026-07-08T09:00:00.000Z', status: 'skipped' },
        { scheduledAt: '2026-07-09T09:00:00.000Z', status: 'failed' },
      ]}
    />)

    expect(screen.getByRole('img', {
      name: 'Nightly report schedule: 3 planned runs, 1 ran, 1 skipped, and 1 failed.',
    })).toBeInTheDocument()
    expect(screen.getByTestId('cron-slot-succeeded')).toHaveAttribute('data-status', 'succeeded')
    expect(screen.getByTestId('cron-slot-skipped')).toHaveAttribute('data-status', 'skipped')
    expect(screen.getByTestId('cron-slot-failed')).toHaveAttribute('data-status', 'failed')
  })

  it('pulses an in-flight slot and calls it out in the accessible summary', () => {
    render(<CronSparkChart
      label="Nightly report schedule"
      data={[
        { scheduledAt: '2026-07-08T09:00:00.000Z', status: 'succeeded' },
        { scheduledAt: '2026-07-09T09:00:00.000Z', status: 'running' },
      ]}
    />)

    expect(screen.getByRole('img', {
      name: 'Nightly report schedule: 2 planned runs, 1 ran, 1 running, 0 skipped, and 0 failed.',
    })).toBeInTheDocument()
    const runningSlot = screen.getByTestId('cron-slot-running')
    expect(runningSlot).toHaveAttribute('data-status', 'running')
    expect(runningSlot).toHaveClass('fill-emerald-500', 'animate-pulse')
  })

  it('shows a run detail on column hover and nothing on pre-history slots', () => {
    render(<CronSparkChart
      label="Nightly report schedule"
      data={[
        { scheduledAt: '2026-07-09T11:00:00.000Z', status: 'succeeded' },
        { scheduledAt: '2026-07-09T12:00:00.000Z', status: 'failed' },
      ]}
    />)

    const bands = screen.getAllByTestId('spark-hit')
    expect(bands).toHaveLength(14)

    // Newest run is the last band.
    fireEvent.mouseEnter(bands[13])
    expect(screen.getByTestId('spark-tooltip')).toHaveTextContent('Failed')

    // Hovering an empty pre-creation slot clears it rather than showing a blank.
    fireEvent.mouseEnter(bands[0])
    expect(screen.queryByTestId('spark-tooltip')).not.toBeInTheDocument()

    fireEvent.mouseEnter(bands[12])
    expect(screen.getByTestId('spark-tooltip')).toHaveTextContent('Succeeded')
    fireEvent.mouseLeave(screen.getByRole('img'))
    expect(screen.queryByTestId('spark-tooltip')).not.toBeInTheDocument()
  })

  it('renders the hover card outside the chart, in viewport space, so overflow-hidden rows cannot clip it', () => {
    const { container } = render(
      <div style={{ overflow: 'hidden' }}>
        <CronSparkChart
          label="Nightly report schedule"
          data={[{ scheduledAt: '2026-07-09T11:00:00.000Z', status: 'succeeded' }]}
        />
      </div>,
    )
    const svg = screen.getByRole('img')
    // Mid-page chart: the card hangs above it, right edges aligned.
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(
      { top: 300, right: 900, bottom: 320, left: 824, width: 76, height: 20, x: 824, y: 300, toJSON: () => ({}) },
    )
    const bands = screen.getAllByTestId('spark-hit')
    fireEvent.mouseEnter(bands[13])

    const tip = screen.getByTestId('spark-tooltip')
    expect(container).not.toContainElement(tip)
    expect(document.body).toContainElement(tip)
    expect(tip).toHaveClass('fixed')
    expect(tip).toHaveStyle({ left: '900px', top: '294px', transform: 'translate(-100%, -100%)' })

    // First row of a page: no room above, so the card flips underneath.
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(
      { top: 12, right: 900, bottom: 32, left: 824, width: 76, height: 20, x: 824, y: 12, toJSON: () => ({}) },
    )
    fireEvent.mouseEnter(bands[13])
    expect(screen.getByTestId('spark-tooltip')).toHaveStyle({ top: '38px', transform: 'translateX(-100%)' })

    // A scroll would strand the card where the chart used to be, so it dismisses.
    fireEvent.scroll(window)
    expect(screen.queryByTestId('spark-tooltip')).not.toBeInTheDocument()
  })

  it('keeps hit bands inside the viewBox without overlapping', () => {
    render(<CronSparkChart label="Bands" data={[]} />)
    const bands = screen.getAllByTestId('spark-hit')
    const box = (el: HTMLElement) => {
      const x = Number(el.getAttribute('x'))
      return { x, right: x + Number(el.getAttribute('width')) }
    }
    expect(box(bands[0]).x).toBe(0)
    expect(box(bands[13]).right).toBeCloseTo(76, 5)
    for (let i = 1; i < bands.length; i++) {
      expect(box(bands[i]).x).toBeCloseTo(box(bands[i - 1]).right, 5)
    }
  })

  it('uses one fixed right-aligned slot grid when tasks have different history lengths', () => {
    const { container: longer } = render(<CronSparkChart
      label="Longer history"
      data={[
        { scheduledAt: '2026-07-09T08:00:00.000Z', status: 'succeeded' },
        { scheduledAt: '2026-07-09T09:00:00.000Z', status: 'succeeded' },
        { scheduledAt: '2026-07-09T10:00:00.000Z', status: 'skipped' },
        { scheduledAt: '2026-07-09T11:00:00.000Z', status: 'succeeded' },
        { scheduledAt: '2026-07-09T12:00:00.000Z', status: 'failed' },
      ]}
    />)
    const { container: shorter } = render(<CronSparkChart
      label="Shorter history"
      data={[
        { scheduledAt: '2026-07-09T10:00:00.000Z', status: 'skipped' },
        { scheduledAt: '2026-07-09T11:00:00.000Z', status: 'succeeded' },
        { scheduledAt: '2026-07-09T12:00:00.000Z', status: 'failed' },
      ]}
    />)

    const longerX = [...longer.querySelectorAll('rect[data-status]')]
      .slice(-3)
      .map((slot) => slot.getAttribute('x'))
    const shorterX = [...shorter.querySelectorAll('rect[data-status]')]
      .map((slot) => slot.getAttribute('x'))

    expect(shorterX).toEqual(longerX)
    expect(Number(shorterX[0])).toBeGreaterThan(0)
  })

  it('fills missing pre-creation history with neutral placeholders up to the fixed N', () => {
    render(<CronSparkChart
      label="New schedule"
      data={[
        { scheduledAt: '2026-07-09T10:00:00.000Z', status: 'skipped' },
        { scheduledAt: '2026-07-09T11:00:00.000Z', status: 'succeeded' },
        { scheduledAt: '2026-07-09T12:00:00.000Z', status: 'failed' },
      ]}
    />)

    const noHistorySlots = screen.getAllByTestId('cron-slot-no-history')
    expect(noHistorySlots).toHaveLength(11)
    expect(noHistorySlots[0]).toHaveClass('fill-muted-foreground/10')
    expect(noHistorySlots[0]).toHaveAttribute('x', '0')
    // Every slot draws a track; the three with history draw a status bar on top.
    expect(screen.getAllByTestId('cron-slot-track')).toHaveLength(3)
    expect(document.querySelectorAll('rect[data-status]')).toHaveLength(3)
    // 14 tracks + 3 status bars + 14 hit bands.
    expect(document.querySelectorAll('rect')).toHaveLength(31)
    expect(screen.getByRole('img', {
      name: 'New schedule: 3 planned runs, 1 ran, 1 skipped, and 1 failed.',
    })).toBeInTheDocument()
  })
})
