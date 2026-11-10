// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MonitorEventItem } from './monitor-event-item'
import type { ApiMonitorEvent } from '@shared/lib/types/api'

function item(overrides: Partial<ApiMonitorEvent> = {}): ApiMonitorEvent {
  return {
    id: 'uuid-1',
    type: 'monitor_event',
    taskId: 'b8ezoj4kh',
    description: 'probe ticks',
    events: ['tick-1'],
    status: null,
    endReason: null,
    createdAt: new Date(),
    ...overrides,
  }
}

describe('MonitorEventItem', () => {
  it('shows the watch and what it printed', () => {
    render(<MonitorEventItem item={item()} />)
    const row = screen.getByTestId('monitor-event-item')
    expect(row).toHaveTextContent('Monitorprobe ticks')
    expect(screen.getByTestId('monitor-event-lines')).toHaveTextContent('tick-1')
  })

  it('keeps each event of a batch apart, and a multi-line event whole', () => {
    render(<MonitorEventItem item={item({ events: ['a1\na2', 'b1'] })} />)
    const blocks = screen.getByTestId('monitor-event-lines').querySelectorAll('pre')
    expect([...blocks].map((block) => block.textContent)).toEqual(['a1\na2', 'b1'])
  })

  it('says how the watch ended, in the runtime\'s words', () => {
    render(<MonitorEventItem item={item({ status: 'failed', endReason: 'script failed (exit 3)', events: ['last'] })} />)
    expect(screen.getByText('script failed (exit 3)')).toHaveClass('text-destructive')
  })

  it('draws no output box for a batch with no lines', () => {
    render(<MonitorEventItem item={item({ status: 'completed', endReason: 'stream ended', events: [] })} />)
    expect(screen.queryByTestId('monitor-event-lines')).not.toBeInTheDocument()
    expect(screen.getByText('stream ended')).not.toHaveClass('text-destructive')
  })
})
