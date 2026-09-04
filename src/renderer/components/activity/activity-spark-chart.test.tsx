// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
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
