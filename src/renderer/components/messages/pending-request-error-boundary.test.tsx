// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders as render } from '@renderer/test/test-utils'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const captureRendererException = vi.fn()
vi.mock('@renderer/lib/error-reporting', () => ({
  captureRendererException: (...args: unknown[]) => captureRendererException(...args),
}))

import { PendingRequestErrorBoundary } from './pending-request-error-boundary'

function Boom(): never {
  throw new Error('requirements.map is not a function')
}

const defaultProps = {
  sessionId: 's-1',
  agentSlug: 'agent-1',
}

describe('PendingRequestErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Both useInterruptSession and useSendMessage go through apiFetch.
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })
  })

  it('renders children when they do not throw', () => {
    render(
      <PendingRequestErrorBoundary {...defaultProps} onDismiss={vi.fn()}>
        <div>healthy card</div>
      </PendingRequestErrorBoundary>
    )
    expect(screen.getByText('healthy card')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-request-error-boundary')).not.toBeInTheDocument()
  })

  it('shows the fallback (not a crash) when a child throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <PendingRequestErrorBoundary {...defaultProps} onDismiss={vi.fn()}>
        <Boom />
      </PendingRequestErrorBoundary>
    )
    expect(screen.getByTestId('pending-request-error-boundary')).toBeInTheDocument()
    expect(screen.getByText("This request couldn't be displayed")).toBeInTheDocument()
    spy.mockRestore()
  })

  it('reports the error to Sentry with the request kind', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <PendingRequestErrorBoundary {...defaultProps} onDismiss={vi.fn()} itemId="tu-9" kind="browser_input">
        <Boom />
      </PendingRequestErrorBoundary>
    )
    expect(captureRendererException).toHaveBeenCalledTimes(1)
    const [error, context] = captureRendererException.mock.calls[0] as [
      Error,
      { tags: Record<string, string>; extra: Record<string, unknown> },
    ]
    expect(error).toBeInstanceOf(Error)
    expect(context.tags).toMatchObject({ feature: 'pending-request-render', request_kind: 'browser_input' })
    expect(context.extra).toMatchObject({ itemId: 'tu-9' })
    spy.mockRestore()
  })

  it('dismiss interrupts the session and sends corrective feedback, then clears the card', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    const onDismiss = vi.fn()

    render(
      <PendingRequestErrorBoundary {...defaultProps} onDismiss={onDismiss}>
        <Boom />
      </PendingRequestErrorBoundary>
    )

    await user.click(screen.getByTestId('pending-request-error-dismiss'))

    // The broken card is always cleared (onDismiss = the descriptor's onComplete).
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1))

    const urls = mockApiFetch.mock.calls.map((c) => c[0] as string)
    expect(urls.some((u) => u.includes('/agents/agent-1/sessions/s-1/interrupt'))).toBe(true)
    expect(urls.some((u) => u.includes('/agents/agent-1/sessions/s-1/messages'))).toBe(true)

    // The message body carries actionable feedback to the agent.
    const messagesCall = mockApiFetch.mock.calls.find((c) => (c[0] as string).includes('/messages'))!
    const body = JSON.parse((messagesCall[1] as { body: string }).body) as { content: string }
    expect(body.content).toMatch(/malformed/i)

    spy.mockRestore()
  })

  it('still clears the card when the network calls fail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    mockApiFetch.mockRejectedValue(new Error('network down'))

    render(
      <PendingRequestErrorBoundary {...defaultProps} onDismiss={onDismiss}>
        <Boom />
      </PendingRequestErrorBoundary>
    )

    await user.click(screen.getByTestId('pending-request-error-dismiss'))
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1))

    spy.mockRestore()
  })
})
