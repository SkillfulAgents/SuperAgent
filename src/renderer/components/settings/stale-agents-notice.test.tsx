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
  return { rows, stopAll: vi.fn(), isStopping: false, stoppedCount: 0, ...overrides }
}

const row = (slug: string, name: string, working = false): StaleAgentRow => ({ slug, name, working })

describe('StaleAgentsNotice', () => {
  beforeEach(() => useStaleAgentsMock.mockReset())

  it('renders nothing when the host lists no agents and this mount stopped none', () => {
    useStaleAgentsMock.mockReturnValue(state([]))
    const { container } = render(<StaleAgentsNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the count, expands to names with the working marker, and offers Stop all', () => {
    const s = state([row('a', 'Research assistant'), row('b', 'Shopify ops', true)])
    useStaleAgentsMock.mockReturnValue(s)
    render(<StaleAgentsNotice />)
    expect(screen.getByText(/Stop them and they start fresh on their next message/)).toBeInTheDocument()
    expect(screen.queryByText(/Shopify ops/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /2 running agents/ }))
    expect(screen.getByText('Research assistant')).toBeInTheDocument()
    expect(screen.getByText('Shopify ops')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'working' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'running' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stop all' }))
    expect(s.stopAll).toHaveBeenCalledTimes(1)
  })

  it('disables the button while stopping, then keeps the count this mount stopped', () => {
    useStaleAgentsMock.mockReturnValue(state([row('a', 'Research assistant')], { isStopping: true }))
    const { rerender } = render(<StaleAgentsNotice />)
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled()

    useStaleAgentsMock.mockReturnValue(state([], { stoppedCount: 1 }))
    rerender(<StaleAgentsNotice />)
    expect(screen.getByText('1 agent stopped.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
