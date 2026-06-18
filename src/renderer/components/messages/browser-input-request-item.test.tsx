// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import { useEffect } from 'react'
import { useDraft } from '@renderer/context/drafts-context'
import { BrowserInputRequestItem } from './browser-input-request-item'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

// A promise we resolve by hand, so a test can observe the component WHILE a
// request is in flight (proves the second call awaits the first, and that
// controls are disabled mid-request).
function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// Probe to read the shared session draft (renderWithProviders wraps DraftsProvider).
function DraftProbe({ sessionId }: { sessionId: string }) {
  const [value] = useDraft<string>(`session:${sessionId}`)
  return <div data-testid="draft-probe">{value ?? ''}</div>
}

// Seeds the shared session draft on mount — simulates text the user had already
// typed in the composer before declining.
function DraftSeeder({ sessionId, value }: { sessionId: string; value: string }) {
  const [, setDraft] = useDraft<string>(`session:${sessionId}`)
  useEffect(() => {
    setDraft(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

const defaultProps = {
  toolUseId: 'tu-1',
  message: 'Complete the Cloudflare challenge',
  requirements: ['Solve the CAPTCHA', 'Click Log in'],
  sessionId: 's-1',
  agentSlug: 'my-agent',
  onComplete: vi.fn(),
}

// Props for the requirements-hardening tests merged in from upstream (b37838ff).
const baseProps = {
  toolUseId: 'tu-1',
  message: 'Log in to the dashboard',
  sessionId: 's-1',
  agentSlug: 'agent-1',
  onComplete: vi.fn(),
}

const COMPLETE_URL = '/api/agents/my-agent/sessions/s-1/complete-browser-input'
const MESSAGES_URL = '/api/agents/my-agent/sessions/s-1/messages'

const ok = () => ({ ok: true, json: () => Promise.resolve({}) })

describe('BrowserInputRequestItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders Decline and Done buttons', () => {
    render(<BrowserInputRequestItem {...defaultProps} />)
    expect(screen.getByTestId('browser-input-decline-btn')).toBeInTheDocument()
    expect(screen.getByTestId('browser-input-complete-btn')).toBeInTheDocument()
  })

  it('decline with no reason → posts only the decline, shows Declined, touches no draft or error', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce(ok())

    render(
      <>
        <BrowserInputRequestItem {...defaultProps} />
        <DraftProbe sessionId="s-1" />
      </>
    )
    await user.click(screen.getByTestId('browser-input-decline-btn'))

    await waitFor(() => expect(screen.getByText('Declined')).toBeInTheDocument())
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockApiFetch.mock.calls[0]
    expect(url).toBe(COMPLETE_URL)
    expect(opts.method).toBe('POST')
    // Exact shape guarantees the reason never rides in the decline body.
    expect(JSON.parse(opts.body)).toEqual({ toolUseId: 'tu-1', decline: true })
    expect(defaultProps.onComplete).toHaveBeenCalledTimes(1)
    // No reason → nothing written to the composer draft, no error surfaced.
    expect(screen.getByTestId('draft-probe')).toHaveTextContent('')
    expect(screen.queryByText(/Error:/)).not.toBeInTheDocument()
  })

  it('decline with a reason → awaits the decline, then posts the exact reason to /messages in order', async () => {
    const user = userEvent.setup()
    const declineCall = deferred()
    mockApiFetch
      .mockReturnValueOnce(declineCall.promise) // complete-browser-input (held open)
      .mockResolvedValueOnce(ok()) // messages

    render(
      <>
        <BrowserInputRequestItem {...defaultProps} />
        <DraftProbe sessionId="s-1" />
      </>
    )
    await user.click(screen.getByTestId('browser-input-decline-btn-chevron'))
    const textarea = await screen.findByPlaceholderText('Reason for declining...')
    await user.type(textarea, 'Skip the login, the data is public at /api/x{Enter}')

    // While the decline is in flight: only the decline call has fired, /messages
    // has NOT (it must await the decline), and the controls are disabled.
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockApiFetch.mock.calls[0][0]).toBe(COMPLETE_URL)
    expect(screen.getByTestId('browser-input-decline-btn')).toBeDisabled()
    expect(screen.getByTestId('browser-input-complete-btn')).toBeDisabled()

    // Resolve the decline → the reason is sent.
    declineCall.resolve(ok())
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2))

    const declineReq = mockApiFetch.mock.calls[0]
    const messageReq = mockApiFetch.mock.calls[1]
    expect(declineReq[0]).toBe(COMPLETE_URL)
    expect(declineReq[1].method).toBe('POST')
    expect(JSON.parse(declineReq[1].body)).toEqual({ toolUseId: 'tu-1', decline: true })
    expect(messageReq[0]).toBe(MESSAGES_URL)
    expect(messageReq[1].method).toBe('POST')
    // Exact shape pins the field name (`content`) the /messages route expects.
    expect(JSON.parse(messageReq[1].body)).toEqual({
      content: 'Skip the login, the data is public at /api/x',
    })

    // Happy path: browser work stopped once, no error, draft untouched.
    expect(defaultProps.onComplete).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Failed to send your reason/)).not.toBeInTheDocument()
    expect(screen.getByTestId('draft-probe')).toHaveTextContent('')
  })

  it('disables controls and ignores a second decline while one is in flight', async () => {
    // pointerEventsCheck off so clicking the now-disabled button asserts the
    // guard instead of throwing on pointer-events.
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const declineCall = deferred()
    mockApiFetch.mockReturnValueOnce(declineCall.promise)

    render(<BrowserInputRequestItem {...defaultProps} />)
    const declineBtn = screen.getByTestId('browser-input-decline-btn')
    await user.click(declineBtn)

    expect(declineBtn).toBeDisabled()
    expect(screen.getByTestId('browser-input-complete-btn')).toBeDisabled()

    // A second click mid-request must not fire another complete-browser-input.
    await user.click(declineBtn)
    expect(mockApiFetch).toHaveBeenCalledTimes(1)

    declineCall.resolve(ok())
    await waitFor(() => expect(screen.getByText('Declined')).toBeInTheDocument())
  })

  it('decline failure with a reason → never posts the reason, stays pending, surfaces the error', async () => {
    const user = userEvent.setup()
    // The decline itself fails.
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'decline boom' }),
    })

    render(
      <>
        <BrowserInputRequestItem {...defaultProps} />
        <DraftProbe sessionId="s-1" />
      </>
    )
    await user.click(screen.getByTestId('browser-input-decline-btn-chevron'))
    const textarea = await screen.findByPlaceholderText('Reason for declining...')
    await user.type(textarea, 'Skip the login{Enter}')

    await waitFor(() => expect(screen.getByText(/decline boom/)).toBeInTheDocument())
    // The reason must NOT be sent when the decline failed — only the one call.
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockApiFetch.mock.calls[0][0]).toBe(COMPLETE_URL)
    // Not declined; reverted to pending (action buttons still present).
    expect(screen.queryByText('Declined')).not.toBeInTheDocument()
    expect(screen.getByTestId('browser-input-decline-btn')).toBeInTheDocument()
    expect(screen.getByTestId('browser-input-complete-btn')).toBeInTheDocument()
    expect(defaultProps.onComplete).not.toHaveBeenCalled()
    // Reason was never accepted, so nothing is stashed in the draft.
    expect(screen.getByTestId('draft-probe')).toHaveTextContent('')
  })

  // NOTE: with onComplete mocked as a no-op the item stays mounted, so the error
  // banner is assertable here. In production onComplete removes the request and
  // unmounts the item, so the banner is best-effort; the draft-probe assertion below
  // is the load-bearing one — the preserved composer draft is the durable recovery.
  it('decline succeeds but the reason send fails → surfaces error and preserves the reason in the composer draft', async () => {
    const user = userEvent.setup()
    mockApiFetch
      .mockResolvedValueOnce(ok()) // decline ok
      .mockResolvedValueOnce({ ok: false }) // messages fail (body is never read on this path)

    render(
      <>
        <BrowserInputRequestItem {...defaultProps} />
        <DraftProbe sessionId="s-1" />
      </>
    )
    await user.click(screen.getByTestId('browser-input-decline-btn-chevron'))
    const textarea = await screen.findByPlaceholderText('Reason for declining...')
    await user.type(textarea, 'Skip the login{Enter}')

    await waitFor(() => expect(screen.getByText(/Failed to send your reason/)).toBeInTheDocument())
    // Both calls happened, to the right endpoints, in order.
    expect(mockApiFetch).toHaveBeenCalledTimes(2)
    expect(mockApiFetch.mock.calls[0][0]).toBe(COMPLETE_URL)
    expect(mockApiFetch.mock.calls[1][0]).toBe(MESSAGES_URL)
    // The decline itself succeeded — browser work was stopped exactly once.
    expect(defaultProps.onComplete).toHaveBeenCalledTimes(1)
    // Durable recovery: the exact reason is preserved in the composer draft.
    expect(screen.getByTestId('draft-probe')).toHaveTextContent('Skip the login')
  })

  it('failed send appends the reason to existing composer text instead of overwriting it', async () => {
    const user = userEvent.setup()
    mockApiFetch
      .mockResolvedValueOnce(ok()) // decline ok
      .mockResolvedValueOnce({ ok: false }) // messages fail

    render(
      <>
        <DraftSeeder sessionId="s-1" value="half-typed thought" />
        <BrowserInputRequestItem {...defaultProps} />
        <DraftProbe sessionId="s-1" />
      </>
    )
    await waitFor(() =>
      expect(screen.getByTestId('draft-probe')).toHaveTextContent('half-typed thought')
    )
    await user.click(screen.getByTestId('browser-input-decline-btn-chevron'))
    const textarea = await screen.findByPlaceholderText('Reason for declining...')
    await user.type(textarea, 'Skip the login{Enter}')

    await waitFor(() => expect(screen.getByText(/Failed to send your reason/)).toBeInTheDocument())
    // Both the pre-existing draft and the reason survive — nothing is clobbered.
    const probe = screen.getByTestId('draft-probe')
    expect(probe).toHaveTextContent('half-typed thought')
    expect(probe).toHaveTextContent('Skip the login')
  })

  it('a whitespace-only reason is treated as no reason → no /messages call', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce(ok())

    render(<BrowserInputRequestItem {...defaultProps} />)
    await user.click(screen.getByTestId('browser-input-decline-btn-chevron'))
    const textarea = await screen.findByPlaceholderText('Reason for declining...')
    // DeclineButton trims to undefined; handleDecline relies on that, so a blank
    // reason must behave exactly like a plain decline (no message sent).
    await user.type(textarea, '   {Enter}')

    await waitFor(() => expect(screen.getByText('Declined')).toBeInTheDocument())
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockApiFetch.mock.calls[0][0]).toBe(COMPLETE_URL)
  })

  it('completes (Done) → posts only the toolUseId, shows Completed, calls onComplete', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce(ok())

    render(<BrowserInputRequestItem {...defaultProps} />)
    await user.click(screen.getByTestId('browser-input-complete-btn'))

    await waitFor(() => expect(screen.getByText('Completed')).toBeInTheDocument())
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockApiFetch.mock.calls[0]
    expect(url).toBe(COMPLETE_URL)
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ toolUseId: 'tu-1' }) // no decline field
    expect(defaultProps.onComplete).toHaveBeenCalledTimes(1)
  })

  // --- requirements hardening (merged from upstream b37838ff) ---
  it('renders the requirements list when requirements is an array', () => {
    render(<BrowserInputRequestItem {...baseProps} requirements={['Enter email', 'Solve 2FA']} />)
    expect(screen.getByText('Enter email')).toBeInTheDocument()
    expect(screen.getByText('Solve 2FA')).toBeInTheDocument()
  })

  // Regression for the "requirements.map is not a function" full-view crash.
  // The model can emit `requirements` as a bare string instead of a string[].
  // A non-empty string passes `.length > 0` and then throws on `.map` — and
  // because request cards render outside the per-message error boundary, that
  // throw blanked the entire chat view. The component must coerce non-arrays.
  it('does not crash when requirements is a non-array string', () => {
    expect(() =>
      render(
        <BrowserInputRequestItem
          {...baseProps}
          requirements={'Enter your email and password' as unknown as string[]}
        />
      )
    ).not.toThrow()

    // The request message still renders; the malformed requirements are dropped
    // (not rendered as a stray string).
    expect(screen.getByText('Log in to the dashboard')).toBeInTheDocument()
    expect(screen.queryByText('Enter your email and password')).not.toBeInTheDocument()
  })

  it('does not render a requirements block when requirements is missing', () => {
    render(
      <BrowserInputRequestItem
        {...baseProps}
        requirements={undefined as unknown as string[]}
      />
    )
    expect(screen.getByText('Log in to the dashboard')).toBeInTheDocument()
  })
})
