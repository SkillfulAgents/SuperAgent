// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@renderer/test/test-utils'
import { StaleSessionNotice } from './stale-session-notice'

describe('StaleSessionNotice', () => {
  it('offers to ignore, start fresh, or summarize and continue, each in one click', async () => {
    const user = userEvent.setup()
    const onIgnore = vi.fn()
    const onContinueCompacted = vi.fn()
    const onStartFresh = vi.fn()
    renderWithProviders(
      <StaleSessionNotice onIgnore={onIgnore} onContinueCompacted={onContinueCompacted} onStartFresh={onStartFresh} />,
    )

    expect(screen.getByText('Start a new conversation?')).toBeInTheDocument()
    expect(screen.getByTestId('stale-toast')).toHaveClass('mb-2')
    expect(screen.getByTestId('stale-toast-card')).toHaveClass('bg-card')
    expect(screen.getByTestId('stale-toast-card')).not.toHaveClass('bg-muted/50')
    await user.click(screen.getByTestId('stale-toast-ignore'))
    await user.click(screen.getByTestId('stale-new-chat'))
    await user.click(screen.getByTestId('stale-summarize-continue'))
    expect(onIgnore).toHaveBeenCalledOnce()
    expect(onStartFresh).toHaveBeenCalledOnce()
    expect(onContinueCompacted).toHaveBeenCalledOnce()
  })

  it('explains why focused conversations work better', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <StaleSessionNotice onIgnore={vi.fn()} onContinueCompacted={vi.fn()} onStartFresh={vi.fn()} />,
    )

    await user.click(screen.getByTestId('stale-learn-more-trigger'))
    expect(screen.getByText('Your agent can handle many conversations at once.')).toBeInTheDocument()
    expect(screen.getByText('Agents re-read everything each time they reply.')).toBeInTheDocument()
    expect(screen.getByText('Summarize & continue keeps the thread, not the bulk.')).toBeInTheDocument()
  })
})
