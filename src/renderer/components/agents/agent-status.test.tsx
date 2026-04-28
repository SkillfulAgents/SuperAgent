// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { getAgentActivityStatus, AgentStatus } from './agent-status'

// Mock cn utility
vi.mock('@shared/lib/utils/cn', () => ({
  cn: (...args: unknown[]) => {
    const classes: string[] = []
    for (const arg of args) {
      if (typeof arg === 'string') classes.push(arg)
      else if (typeof arg === 'object' && arg !== null) {
        for (const [key, value] of Object.entries(arg)) {
          if (value) classes.push(key)
        }
      }
    }
    return classes.join(' ')
  },
}))

describe('getAgentActivityStatus', () => {
  it('returns sleeping when container is stopped', () => {
    expect(getAgentActivityStatus('stopped', false)).toBe('sleeping')
  })

  it('returns sleeping when stopped even with active sessions', () => {
    expect(getAgentActivityStatus('stopped', true)).toBe('sleeping')
  })

  it('returns sleeping when stopped even with awaiting input', () => {
    expect(getAgentActivityStatus('stopped', true, true)).toBe('sleeping')
  })

  it('returns idle when running with no active sessions', () => {
    expect(getAgentActivityStatus('running', false)).toBe('idle')
  })

  it('returns working when running with active sessions', () => {
    expect(getAgentActivityStatus('running', true)).toBe('working')
  })

  it('returns awaiting_input when running with sessions awaiting input', () => {
    expect(getAgentActivityStatus('running', true, true)).toBe('awaiting_input')
  })

  it('awaiting_input takes priority over working', () => {
    // Both active and awaiting — awaiting wins because it's more actionable
    expect(getAgentActivityStatus('running', true, true)).toBe('awaiting_input')
  })

  it('returns awaiting_input even if hasActiveSessions is false', () => {
    // Edge case: shouldn't happen in practice but status should still be defined
    expect(getAgentActivityStatus('running', false, true)).toBe('awaiting_input')
  })

  it('defaults hasSessionsAwaitingInput to false when omitted', () => {
    expect(getAgentActivityStatus('running', true)).toBe('working')
  })
})

describe('AgentStatus component', () => {
  it('renders sleeping status with muted text', () => {
    render(<AgentStatus status="stopped" />)
    const el = screen.getByTestId('agent-status')
    expect(el).toHaveAttribute('data-status', 'sleeping')
    expect(screen.getByText('sleeping')).toBeInTheDocument()
  })

  it('renders idle status with blue text', () => {
    render(<AgentStatus status="running" />)
    const el = screen.getByTestId('agent-status')
    expect(el).toHaveAttribute('data-status', 'idle')
    expect(screen.getByText('idle')).toBeInTheDocument()
  })

  it('renders working status with green text', () => {
    render(<AgentStatus status="running" hasActiveSessions />)
    const el = screen.getByTestId('agent-status')
    expect(el).toHaveAttribute('data-status', 'working')
    expect(screen.getByText('working')).toBeInTheDocument()
  })

  it('renders awaiting_input status with orange text', () => {
    render(<AgentStatus status="running" hasActiveSessions hasSessionsAwaitingInput />)
    const el = screen.getByTestId('agent-status')
    expect(el).toHaveAttribute('data-status', 'awaiting_input')
    expect(screen.getByText('needs input')).toBeInTheDocument()
  })

  it('data-status attribute matches for each status', () => {
    const cases: Array<{ props: Parameters<typeof AgentStatus>[0]; expected: string }> = [
      { props: { status: 'stopped' }, expected: 'sleeping' },
      { props: { status: 'running' }, expected: 'idle' },
      { props: { status: 'running', hasActiveSessions: true }, expected: 'working' },
      { props: { status: 'running', hasActiveSessions: true, hasSessionsAwaitingInput: true }, expected: 'awaiting_input' },
    ]

    for (const { props, expected } of cases) {
      const { unmount } = render(<AgentStatus {...props} />)
      expect(screen.getByTestId('agent-status')).toHaveAttribute('data-status', expected)
      unmount()
    }
  })
})
