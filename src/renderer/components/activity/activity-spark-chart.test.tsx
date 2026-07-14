// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
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
    expect(screen.getByText('Jul 8: 3 succeeded, 1 failed')).toBeInTheDocument()
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
    expect(noHistorySlots).toHaveLength(15)
    expect(noHistorySlots[0]).toHaveClass('fill-none', 'stroke-muted-foreground/20')
    expect(noHistorySlots[0]).toHaveAttribute('x', '0.5')
    expect(noHistorySlots[0]).toHaveAttribute('y', '4.5')
    expect(noHistorySlots[0]).toHaveAttribute('width', '3')
    expect(noHistorySlots[0]).toHaveAttribute('height', '17')
    expect(document.querySelectorAll('rect')).toHaveLength(18)
    expect(screen.getByRole('img', {
      name: 'New schedule: 3 planned runs, 1 ran, 1 skipped, and 1 failed.',
    })).toBeInTheDocument()
  })
})
