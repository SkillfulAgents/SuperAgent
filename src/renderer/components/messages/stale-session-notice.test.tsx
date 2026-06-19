// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@renderer/test/test-utils'
import { StaleSessionToast, type StaleSessionToastProps } from './stale-session-notice'

function makeProps(overrides: Partial<StaleSessionToastProps> = {}): StaleSessionToastProps {
  return {
    onIgnore: vi.fn(),
    onStartSummary: vi.fn(),
    onStartFresh: vi.fn(),
    isSummarizing: false,
    summaryError: null,
    onRetrySummary: vi.fn(),
    onMenuOpenChange: vi.fn(),
    ...overrides,
  }
}

describe('StaleSessionToast', () => {
  it('renders the toast, title, and action buttons', () => {
    renderWithProviders(<StaleSessionToast {...makeProps()} />)
    expect(screen.getByTestId('stale-toast')).toBeInTheDocument()
    expect(screen.getByText('Continue this conversation here?')).toBeInTheDocument()
    expect(screen.getByTestId('stale-toast-ignore')).toBeInTheDocument()
    expect(screen.getByTestId('stale-new-chat-trigger')).toBeInTheDocument()
  })

  it('calls onIgnore when Ignore is clicked', async () => {
    const user = userEvent.setup()
    const props = makeProps()
    renderWithProviders(<StaleSessionToast {...props} />)
    await user.click(screen.getByTestId('stale-toast-ignore'))
    expect(props.onIgnore).toHaveBeenCalledOnce()
  })

  it('opens the New conversation popover and calls onStartSummary', async () => {
    const user = userEvent.setup()
    const props = makeProps()
    renderWithProviders(<StaleSessionToast {...props} />)
    await user.click(screen.getByTestId('stale-new-chat-trigger'))
    expect(screen.getByTestId('stale-new-chat-popover')).toBeInTheDocument()
    await user.click(screen.getByTestId('stale-new-chat-summary'))
    expect(props.onStartSummary).toHaveBeenCalledOnce()
  })

  it('opens the New conversation popover and calls onStartFresh', async () => {
    const user = userEvent.setup()
    const props = makeProps()
    renderWithProviders(<StaleSessionToast {...props} />)
    await user.click(screen.getByTestId('stale-new-chat-trigger'))
    await user.click(screen.getByTestId('stale-new-chat-fresh'))
    expect(props.onStartFresh).toHaveBeenCalledOnce()
  })

  it('shows spinner and disables Start fresh while summarizing', async () => {
    const user = userEvent.setup()
    const props = makeProps({ isSummarizing: true })
    renderWithProviders(<StaleSessionToast {...props} />)
    await user.click(screen.getByTestId('stale-new-chat-trigger'))
    expect(screen.getByTestId('stale-new-chat-summarizing')).toBeInTheDocument()
    expect(screen.queryByTestId('stale-new-chat-summary')).not.toBeInTheDocument()
    expect(screen.getByTestId('stale-new-chat-fresh')).toBeDisabled()
  })

  it('renders error text and calls onRetrySummary when Retry is clicked', async () => {
    const user = userEvent.setup()
    const props = makeProps({ summaryError: 'Something went wrong' })
    renderWithProviders(<StaleSessionToast {...props} />)
    await user.click(screen.getByTestId('stale-new-chat-trigger'))
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    await user.click(screen.getByTestId('stale-new-chat-retry'))
    expect(props.onRetrySummary).toHaveBeenCalledOnce()
  })

  it('calls onMenuOpenChange(true) when the New conversation popover opens', async () => {
    const user = userEvent.setup()
    const props = makeProps()
    renderWithProviders(<StaleSessionToast {...props} />)
    await user.click(screen.getByTestId('stale-new-chat-trigger'))
    expect(props.onMenuOpenChange).toHaveBeenCalledWith(true)
  })

  it('calls onMenuOpenChange(true) when the Learn more popover opens', async () => {
    const user = userEvent.setup()
    const props = makeProps()
    renderWithProviders(<StaleSessionToast {...props} />)
    await user.click(screen.getByTestId('stale-learn-more-trigger'))
    expect(props.onMenuOpenChange).toHaveBeenCalledWith(true)
  })
})
