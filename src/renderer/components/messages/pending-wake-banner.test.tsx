// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { PendingWakeBanner } from './pending-wake-banner'

describe('PendingWakeBanner', () => {
  it('names the agents it is waiting on when there is no time', () => {
    renderWithProviders(
      <PendingWakeBanner sessionId="s" agentSlug="a" taskId="t" waitingOn={['Researcher', 'Writer']} />,
    )
    expect(screen.getByTestId('pending-wake-banner')).toHaveTextContent('Waiting for Researcher, Writer to finish')
    expect(screen.getByTestId('pending-wake-wake-now')).toBeInTheDocument()
  })

  it('does not leave a blank name when every helper is already stamped', () => {
    renderWithProviders(
      <PendingWakeBanner sessionId="s" agentSlug="a" taskId="t" waitingOn={[]} />,
    )
    expect(screen.getByTestId('pending-wake-banner')).toHaveTextContent('Waiting for agents to finish')
    expect(screen.getByTestId('pending-wake-banner')).not.toHaveTextContent('Waiting for  to finish')
  })

  it('shows both the time and the agents when it has both', () => {
    renderWithProviders(
      <PendingWakeBanner
        sessionId="s"
        agentSlug="a"
        taskId="t"
        wakeAt={new Date(Date.now() + 3600_000).toISOString()}
        waitingOn={['Researcher']}
      />,
    )
    expect(screen.getByTestId('pending-wake-banner')).toHaveTextContent(/auto-resume .* also waiting for Researcher/)
  })
})
