// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComposerActionButton } from './composer-action-button'

describe('ComposerActionButton', () => {
  const baseProps = {
    isActive: false,
    isWaitingBackground: false,
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

  it('renders both stop and a queue-send button when active', () => {
    // Mid-turn the composer keeps a send button (labelled "Queue message") so
    // the user can queue a follow-up while the agent works.
    render(<ComposerActionButton {...baseProps} isActive />)
    expect(screen.getByTestId('stop-button')).toBeInTheDocument()
    const send = screen.getByTestId('send-button')
    expect(send).toBeInTheDocument()
    expect(send).toHaveAttribute('aria-label', 'Queue message')
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

  it('shows both stop and send buttons when waiting for background tasks', () => {
    render(<ComposerActionButton {...baseProps} isActive isWaitingBackground />)
    expect(screen.getByTestId('stop-button')).toBeInTheDocument()
    expect(screen.getByTestId('send-button')).toBeInTheDocument()
  })

  it('send button is enabled when waiting for background with canSubmit', () => {
    render(<ComposerActionButton {...baseProps} isActive isWaitingBackground canSubmit />)
    expect(screen.getByTestId('send-button')).not.toBeDisabled()
  })

  it('stop button calls onInterrupt when waiting for background', async () => {
    const onInterrupt = vi.fn()
    const user = userEvent.setup()
    render(<ComposerActionButton {...baseProps} isActive isWaitingBackground onInterrupt={onInterrupt} />)
    await user.click(screen.getByTestId('stop-button'))
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })
})
