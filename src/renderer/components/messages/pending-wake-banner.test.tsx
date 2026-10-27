// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { PendingWakeBanner } from './pending-wake-banner'

describe('PendingWakeBanner', () => {
  it('uses an opaque surface above the transcript', () => {
    renderWithProviders(
      <PendingWakeBanner
        sessionId="session-1"
        agentSlug="agent-1"
        wakeAt={new Date(Date.now() + 60_000).toISOString()}
        taskId="task-1"
      />,
    )

    expect(screen.getByTestId('pending-wake-banner')).toHaveClass('bg-card')
    expect(screen.getByTestId('pending-wake-banner')).not.toHaveClass('bg-muted/50')
  })

  it('counts down without being re-rendered by its parent', () => {
    vi.useFakeTimers()
    try {
      renderWithProviders(
        <PendingWakeBanner
          sessionId="session-1"
          agentSlug="agent-1"
          wakeAt={new Date(Date.now() + 5 * 60_000).toISOString()}
          taskId="task-1"
        />,
      )
      expect(screen.getByTestId('pending-wake-banner')).toHaveTextContent('in 5 minutes')

      act(() => { vi.advanceTimersByTime(2 * 60_000) })
      expect(screen.getByTestId('pending-wake-banner')).toHaveTextContent('in 3 minutes')
    } finally {
      vi.useRealTimers()
    }
  })
})
