// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@renderer/test/test-utils'
import { StaleSessionNotice } from './stale-session-notice'

describe('StaleSessionNotice', () => {
  it('offers to ignore the prompt or start a new conversation', async () => {
    const user = userEvent.setup()
    const onIgnore = vi.fn()
    const onStartFresh = vi.fn()
    renderWithProviders(
      <StaleSessionNotice onIgnore={onIgnore} onStartFresh={onStartFresh} />,
    )

    expect(screen.getByText('Start a new conversation?')).toBeInTheDocument()
    await user.click(screen.getByTestId('stale-toast-ignore'))
    await user.click(screen.getByTestId('stale-new-chat'))
    expect(onIgnore).toHaveBeenCalledOnce()
    expect(onStartFresh).toHaveBeenCalledOnce()
  })

  it('explains why focused conversations work better', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <StaleSessionNotice onIgnore={vi.fn()} onStartFresh={vi.fn()} />,
    )

    await user.click(screen.getByTestId('stale-learn-more-trigger'))
    expect(screen.getByText('Your agent can handle many conversations at once.')).toBeInTheDocument()
    expect(screen.getByText('Agents re-read everything each time they reply.')).toBeInTheDocument()
  })
})
