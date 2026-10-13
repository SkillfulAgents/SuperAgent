// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { PendingWakeBanner } from './pending-wake-banner'

describe('PendingWakeBanner', () => {
  it('uses the same blurred surface as the stale-session notice', () => {
    renderWithProviders(
      <PendingWakeBanner
        sessionId="session-1"
        agentSlug="agent-1"
        wakeAt={new Date(Date.now() + 60_000).toISOString()}
        taskId="task-1"
      />,
    )

    expect(screen.getByTestId('pending-wake-banner')).toHaveClass('bg-muted/80', 'backdrop-blur-md')
  })

  it('shows the summary rather than the agent\'s note', () => {
    renderWithProviders(
      <PendingWakeBanner
        sessionId="session-1"
        agentSlug="agent-1"
        wakeAt={new Date(Date.now() + 60_000).toISOString()}
        taskId="task-1"
        summary="Waiting on the review"
        note="Check whether the review was approved, then send the release notes"
      />,
    )

    expect(screen.getByTestId('pending-wake-summary')).toHaveTextContent('Waiting on the review')
    expect(screen.getByTestId('pending-wake-banner')).not.toHaveTextContent('release notes')
  })

  it('falls back to the note for a wake scheduled without a summary', () => {
    renderWithProviders(
      <PendingWakeBanner
        sessionId="session-1"
        agentSlug="agent-1"
        wakeAt={new Date(Date.now() + 60_000).toISOString()}
        taskId="task-1"
        note="Check whether the review was approved"
      />,
    )

    expect(screen.getByTestId('pending-wake-summary')).toHaveTextContent('Check whether the review was approved')
  })
})
