// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ClearConversationButton } from './clear-conversation-button'

describe('ClearConversationButton', () => {
  it('opens a confirm dialog and calls onConfirm on confirm', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<ClearConversationButton providerName="Telegram" onConfirm={onConfirm} />)
    await user.click(screen.getByRole('button', { name: /new conversation/i }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText(/archives the current conversation/i)).toBeInTheDocument()
    // Once the modal is open the trigger is aria-hidden, so this resolves to the action.
    await user.click(screen.getByRole('button', { name: /^new conversation$/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('does not call onConfirm when the dialog is cancelled', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<ClearConversationButton providerName="Telegram" onConfirm={onConfirm} />)
    await user.click(screen.getByRole('button', { name: /new conversation/i }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('disables the trigger while a clear is pending', () => {
    render(<ClearConversationButton providerName="Telegram" pending onConfirm={vi.fn()} />)
    expect(screen.getByRole('button', { name: /new conversation/i })).toBeDisabled()
  })
})
