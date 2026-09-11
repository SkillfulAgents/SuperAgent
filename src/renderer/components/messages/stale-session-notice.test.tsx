// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@renderer/test/test-utils'
import { StaleSessionNotice } from './stale-session-notice'

describe('StaleSessionNotice', () => {
  it('offers to ignore in one click, and start fresh or summarize from one dropdown', async () => {
    const user = userEvent.setup()
    const onIgnore = vi.fn()
    const onContinueCompacted = vi.fn()
    const onStartFresh = vi.fn()
    renderWithProviders(
      <StaleSessionNotice onIgnore={onIgnore} onContinueCompacted={onContinueCompacted} onStartFresh={onStartFresh} />,
    )

    expect(screen.getByText('Start a new conversation')).toBeInTheDocument()
    expect(screen.getByTestId('stale-toast')).toHaveClass('mb-2')
    expect(screen.getByTestId('stale-toast-card')).toHaveClass('bg-muted/80')
    await user.click(screen.getByTestId('stale-toast-ignore'))
    expect(onIgnore).toHaveBeenCalledOnce()

    // The two real choices live behind one button, each with a description line.
    expect(screen.queryByTestId('stale-options-popover')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stale-options-trigger'))
    expect(screen.getByTestId('stale-options-popover')).toBeInTheDocument()
    expect(screen.getByText("Condenses this conversation's history and picks up there.")).toBeInTheDocument()
    expect(screen.getByText('Nothing carries over except your unsent message.')).toBeInTheDocument()

    await user.click(screen.getByTestId('stale-summarize-continue'))
    expect(onContinueCompacted).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('stale-options-popover')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('stale-options-trigger'))
    await user.click(screen.getByTestId('stale-new-chat'))
    expect(onStartFresh).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('stale-options-popover')).not.toBeInTheDocument()
  })

  it('reports while either popover is open so the column can hold its scroll', async () => {
    const user = userEvent.setup()
    const onPopoverOpenChange = vi.fn()
    renderWithProviders(
      <StaleSessionNotice
        onIgnore={vi.fn()}
        onContinueCompacted={vi.fn()}
        onStartFresh={vi.fn()}
        onPopoverOpenChange={onPopoverOpenChange}
      />,
    )

    await user.click(screen.getByTestId('stale-options-trigger'))
    expect(onPopoverOpenChange).toHaveBeenLastCalledWith(true)
    await user.keyboard('{Escape}')
    expect(onPopoverOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('explains why focused conversations work better on hover', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <StaleSessionNotice onIgnore={vi.fn()} onContinueCompacted={vi.fn()} onStartFresh={vi.fn()} />,
    )

    // Radix renders tooltip content twice (visible + an aria-live copy), so match any.
    await user.hover(screen.getByTestId('stale-learn-more-trigger'))
    expect(await screen.findAllByText('Agents re-read the whole conversation every reply.')).not.toHaveLength(0)
    expect(screen.getAllByText('One task per conversation works best.')).not.toHaveLength(0)
  })
})
