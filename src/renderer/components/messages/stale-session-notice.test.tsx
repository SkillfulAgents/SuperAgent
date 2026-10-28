// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StaleSessionNotice } from './stale-session-notice'

describe('StaleSessionNotice', () => {
  it('offers to ignore in one click, and start fresh or summarize from one dropdown', async () => {
    const user = userEvent.setup()
    const onIgnore = vi.fn()
    const onContinueCompacted = vi.fn()
    const onStartFresh = vi.fn()
    render(
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

  it('holds scrolling while the menu is open and restores trigger focus on Escape', async () => {
    const user = userEvent.setup()
    const onPopoverOpenChange = vi.fn()
    render(
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
    await waitFor(() => expect(screen.getByTestId('stale-options-trigger')).toHaveFocus())
  })

  it('explains why focused conversations work better on hover', async () => {
    const user = userEvent.setup()
    render(
      <StaleSessionNotice onIgnore={vi.fn()} onContinueCompacted={vi.fn()} onStartFresh={vi.fn()} />,
    )

    // Radix renders tooltip content twice (visible + an aria-live copy), so match any.
    await user.hover(screen.getByTestId('stale-learn-more-trigger'))
    expect(await screen.findAllByText('Agents re-read the whole conversation every reply.')).not.toHaveLength(0)
    expect(screen.getAllByText('One task per conversation works best.')).not.toHaveLength(0)
  })

  it.each(['{Enter}', ' ', '{ArrowDown}'])('opens with %s and selects the fresh option with the keyboard', async (openKey) => {
    const user = userEvent.setup()
    const onContinueCompacted = vi.fn()
    const onStartFresh = vi.fn()
    render(<StaleSessionNotice onIgnore={vi.fn()} onContinueCompacted={onContinueCompacted} onStartFresh={onStartFresh} />)
    const trigger = screen.getByRole('button', { name: 'New conversation' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    act(() => trigger.focus())
    await user.keyboard(openKey)
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Start with a summary' })).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Start totally fresh' })).toHaveFocus())
    await user.keyboard('{Enter}')
    expect(onStartFresh).toHaveBeenCalledOnce()
    expect(onContinueCompacted).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('supports Home, End, reverse navigation, and typeahead without selecting an action', async () => {
    const user = userEvent.setup()
    const onContinueCompacted = vi.fn()
    const onStartFresh = vi.fn()
    render(<StaleSessionNotice onIgnore={vi.fn()} onContinueCompacted={onContinueCompacted} onStartFresh={onStartFresh} />)
    act(() => screen.getByTestId('stale-options-trigger').focus())
    await user.keyboard('{ArrowDown}')
    const summary = screen.getByRole('menuitem', { name: 'Start with a summary' })
    const fresh = screen.getByRole('menuitem', { name: 'Start totally fresh' })
    expect(fresh).toHaveAccessibleDescription('Nothing carries over except your unsent message.')
    await user.keyboard('{End}')
    await waitFor(() => expect(fresh).toHaveFocus())
    await user.keyboard('{Home}')
    await waitFor(() => expect(summary).toHaveFocus())
    await user.keyboard('{End}{ArrowUp}')
    await waitFor(() => expect(summary).toHaveFocus())
    await user.keyboard('start t')
    await waitFor(() => expect(fresh).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(onContinueCompacted).not.toHaveBeenCalled()
    expect(onStartFresh).not.toHaveBeenCalled()
  })

  it('disables actions while pending and makes them available again after settlement', async () => {
    const user = userEvent.setup()
    const onIgnore = vi.fn()
    const onContinueCompacted = vi.fn()
    const onStartFresh = vi.fn()
    const props = { onIgnore, onContinueCompacted, onStartFresh }
    const { rerender } = render(<StaleSessionNotice {...props} isPending />)
    const trigger = screen.getByRole('button', { name: 'Starting new conversation' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    rerender(<StaleSessionNotice {...props} isPending={false} />)
    expect(trigger).toBeEnabled()
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: 'Start totally fresh' }))
    expect(onStartFresh).toHaveBeenCalledOnce()
    expect(onContinueCompacted).not.toHaveBeenCalled()
    expect(onIgnore).not.toHaveBeenCalled()
  })

})
