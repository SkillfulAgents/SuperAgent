// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
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
})
