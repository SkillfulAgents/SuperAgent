// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoginButton, type LoginButtonProps } from './login-button'

const icon = <svg data-testid="icon" />
const base: LoginButtonProps = { icon, label: 'Connect', pendingLabel: 'Connecting…', pending: false, canCancel: false, onCancel: () => {}, cancelSide: 'left' }

describe('LoginButton', () => {
  it('swaps the icon for the spinner, disables, and announces while pending', () => {
    const { rerender } = render(<LoginButton {...base} />)
    const button = screen.getByRole('button', { name: 'Connect' })
    expect(button).toBeEnabled()
    expect(button.contains(screen.getByTestId('icon'))).toBe(true)
    expect(button.querySelector('.animate-spin')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('')

    rerender(<LoginButton {...base} pending />)
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()
    expect(screen.queryByTestId('icon')).toBeNull()
    expect(screen.getByRole('button').querySelector('.animate-spin')).not.toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Connecting…')
    expect(screen.queryByRole('button', { name: 'Cancel sign-in' })).toBeNull()

    rerender(<LoginButton {...base} pending canCancel />)
    expect(screen.getByRole('status')).toHaveTextContent('Connecting…, Cancel available')
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeInTheDocument()
  })

  it('places Cancel on the requested side', () => {
    const { rerender } = render(<LoginButton {...base} pending canCancel cancelSide="left" />)
    const names = () => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(names()).toEqual(['Cancel sign-in', 'Connecting…'])
    rerender(<LoginButton {...base} pending canCancel cancelSide="right" />)
    expect(names()).toEqual(['Connecting…', 'Cancel sign-in'])
  })

  it('returns focus to the button after Cancel, once it can take focus', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const { rerender } = render(<LoginButton {...base} pending canCancel onCancel={onCancel} disabled />)
    await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
    expect(onCancel).toHaveBeenCalledOnce()

    // Pending clears while the caller still holds the button disabled.
    rerender(<LoginButton {...base} onCancel={onCancel} disabled />)
    expect(screen.getByRole('button', { name: 'Connect' })).not.toHaveFocus()
    rerender(<LoginButton {...base} onCancel={onCancel} />)
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveFocus()
  })

  it('renders the button alone for cancelSide none, even when Cancel is available', () => {
    const { container } = render(<LoginButton {...base} pending canCancel cancelSide="none" />)
    expect(container.firstElementChild?.tagName).toBe('BUTTON')
    expect(screen.queryByRole('button', { name: 'Cancel sign-in' })).toBeNull()
  })
})
