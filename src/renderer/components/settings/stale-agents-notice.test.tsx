// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { StaleAgentRow } from '@renderer/hooks/use-stale-agents'

const useStaleAgentsMock = vi.fn()
vi.mock('@renderer/hooks/use-stale-agents', () => ({
  useStaleAgents: () => useStaleAgentsMock(),
}))

import { StaleAgentsNotice } from './stale-agents-notice'

function state(rows: StaleAgentRow[], overrides: Record<string, unknown> = {}) {
  return {
    record: { agents: rows, running: false },
    rows,
    lastRun: null,
    restartAll: vi.fn(),
    isRestarting: false,
    restartError: null,
    ...overrides,
  }
}

const row = (slug: string, status: StaleAgentRow['status'], extra: Partial<StaleAgentRow> = {}): StaleAgentRow =>
  ({ slug, status, name: slug, working: false, ...extra })

describe('StaleAgentsNotice', () => {
  beforeEach(() => useStaleAgentsMock.mockReset())

  it('renders nothing without a host record', () => {
    useStaleAgentsMock.mockReturnValue(state([], { record: null }))
    const { container } = render(<StaleAgentsNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the count, expands to names with the working marker, and offers Restart all', () => {
    const s = state([row('a', 'pending', { name: 'Research assistant' }), row('b', 'pending', { name: 'Shopify ops', working: true })])
    useStaleAgentsMock.mockReturnValue(s)
    render(<StaleAgentsNotice />)
    expect(screen.getByText(/Restart for changes to take effect/)).toBeInTheDocument()
    expect(screen.queryByText(/Shopify ops/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /2 running agents/ }))
    expect(screen.getByText('Research assistant')).toBeInTheDocument()
    expect(screen.getByText('Shopify ops')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'working' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'running' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Restart all' }))
    expect(s.restartAll).toHaveBeenCalledTimes(1)
  })

  it('disables the button and names the agent in flight while a run is running', () => {
    useStaleAgentsMock.mockReturnValue(state([row('a', 'restarted'), row('b', 'restarting')], { isRestarting: true }))
    render(<StaleAgentsNotice />)
    expect(screen.getByText(/Restarting 2 agents one at a time/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restarting…' })).toBeDisabled()
  })

  it('after a run: green count from the run this mount received, red block with Retry from the record', () => {
    const failedRow = row('b', 'failed', { name: 'Shopify ops', error: 'Container failed to become healthy\nstderr: request returned 500\nstdout: []' })
    const s = state([failedRow], { lastRun: [row('a', 'restarted'), failedRow] })
    useStaleAgentsMock.mockReturnValue(s)
    render(<StaleAgentsNotice />)
    expect(screen.getByText('1 agent restarted.')).toBeInTheDocument()
    expect(screen.getByText(/didn't restart: Container failed to become healthy$/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(s.restartAll).toHaveBeenCalledTimes(1)
  })
})
