// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComposerActionButton } from './composer-action-button'

describe('ComposerActionButton', () => {
  const baseProps = {
    isActive: false,
    isWaitingBackground: false,
    hasContent: false,
    canSubmit: true,
    isSending: false,
    isInterrupting: false,
    onInterrupt: vi.fn(),
  }

  it('renders the send button when idle', () => {
    render(<ComposerActionButton {...baseProps} />)
    expect(screen.getByTestId('send-button')).toBeInTheDocument()
    expect(screen.queryByTestId('stop-button')).not.toBeInTheDocument()
  })

  it('renders only the stop button when active with an empty composer', () => {
    render(<ComposerActionButton {...baseProps} isActive />)
    expect(screen.getByTestId('stop-button')).toBeInTheDocument()
    expect(screen.queryByTestId('send-button')).not.toBeInTheDocument()
  })

  it('swaps stop for a queue-send button once the composer has content', () => {
    // Mid-turn the single slot flips to Send (labelled "Queue message") as
    // soon as the user types, so a follow-up can be queued while the agent works.
    render(<ComposerActionButton {...baseProps} isActive hasContent />)
    const send = screen.getByTestId('send-button')
    expect(send).toBeInTheDocument()
    expect(send).toHaveAttribute('aria-label', 'Queue message')
    expect(screen.queryByTestId('stop-button')).not.toBeInTheDocument()
  })

  it('swaps back to the stop button when the composer is cleared', () => {
    const { rerender } = render(<ComposerActionButton {...baseProps} isActive hasContent />)
    expect(screen.getByTestId('send-button')).toBeInTheDocument()
    rerender(<ComposerActionButton {...baseProps} isActive hasContent={false} />)
    expect(screen.getByTestId('stop-button')).toBeInTheDocument()
    expect(screen.queryByTestId('send-button')).not.toBeInTheDocument()
  })

  it('disables the send button when canSubmit is false', () => {
    render(<ComposerActionButton {...baseProps} canSubmit={false} />)
    expect(screen.getByTestId('send-button')).toBeDisabled()
  })

  it('disables the send button while sending', () => {
    render(<ComposerActionButton {...baseProps} isSending />)
    expect(screen.getByTestId('send-button')).toBeDisabled()
  })

  it('calls onInterrupt when the stop button is clicked', async () => {
    const onInterrupt = vi.fn()
    const user = userEvent.setup()
    render(<ComposerActionButton {...baseProps} isActive onInterrupt={onInterrupt} />)
    await user.click(screen.getByTestId('stop-button'))
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it('disables the stop button while interrupting', () => {
    render(<ComposerActionButton {...baseProps} isActive isInterrupting />)
    expect(screen.getByTestId('stop-button')).toBeDisabled()
  })

  it('shows the background stop button when waiting with an empty composer', () => {
    render(<ComposerActionButton {...baseProps} isActive isWaitingBackground />)
    const stop = screen.getByTestId('stop-button')
    expect(stop).toHaveAttribute('aria-label', 'Stop background processes')
    expect(screen.queryByTestId('send-button')).not.toBeInTheDocument()
  })

  it('shows a regular send button when waiting for background with content', () => {
    render(<ComposerActionButton {...baseProps} isActive isWaitingBackground hasContent />)
    const send = screen.getByTestId('send-button')
    expect(send).toHaveAttribute('aria-label', 'Send message')
    expect(send).not.toBeDisabled()
    expect(screen.queryByTestId('stop-button')).not.toBeInTheDocument()
  })

  it('stop button calls onInterrupt when waiting for background', async () => {
    const onInterrupt = vi.fn()
    const user = userEvent.setup()
    render(<ComposerActionButton {...baseProps} isActive isWaitingBackground onInterrupt={onInterrupt} />)
    await user.click(screen.getByTestId('stop-button'))
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })
})
