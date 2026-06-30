// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@renderer/test/test-utils'
import { StaleSessionToast, type StaleSessionToastProps } from './stale-session-notice'

function makeProps(overrides: Partial<StaleSessionToastProps> = {}): StaleSessionToastProps {
  return {
    onIgnore: vi.fn(),
    onStartFresh: vi.fn(),
    onMenuOpenChange: vi.fn(),
    ...overrides,
  }
}

describe('StaleSessionToast', () => {
  it('renders the toast, title, and action buttons', () => {
    renderWithProviders(<StaleSessionToast {...makeProps()} />)
    expect(screen.getByTestId('stale-toast')).toBeInTheDocument()
    expect(screen.getByText('Start a new conversation?')).toBeInTheDocument()
    expect(screen.getByTestId('stale-toast-ignore')).toBeInTheDocument()
    expect(screen.getByTestId('stale-new-chat')).toBeInTheDocument()
  })

  it('calls onIgnore when Ignore is clicked', async () => {
    const user = userEvent.setup()
    const props = makeProps()
    renderWithProviders(<StaleSessionToast {...props} />)
    await user.click(screen.getByTestId('stale-toast-ignore'))
    expect(props.onIgnore).toHaveBeenCalledOnce()
  })

  it('calls onStartFresh when New conversation is clicked', async () => {
    const user = userEvent.setup()
    const props = makeProps()
    renderWithProviders(<StaleSessionToast {...props} />)
    await user.click(screen.getByTestId('stale-new-chat'))
    expect(props.onStartFresh).toHaveBeenCalledOnce()
  })

  it('calls onMenuOpenChange(true) when the Learn more popover opens', async () => {
    const user = userEvent.setup()
    const props = makeProps()
    renderWithProviders(<StaleSessionToast {...props} />)
    await user.click(screen.getByTestId('stale-learn-more-trigger'))
    expect(props.onMenuOpenChange).toHaveBeenCalledWith(true)
  })

  it('reports onMenuOpenChange(false) on unmount so the scroll-to-bottom FAB is not left suppressed', async () => {
    const user = userEvent.setup()
    const props = makeProps()
    const { unmount } = renderWithProviders(<StaleSessionToast {...props} />)
    await user.click(screen.getByTestId('stale-learn-more-trigger'))
    expect(props.onMenuOpenChange).toHaveBeenCalledWith(true)
    unmount()
    expect(props.onMenuOpenChange).toHaveBeenLastCalledWith(false)
  })
})
