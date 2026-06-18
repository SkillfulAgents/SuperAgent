// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import { useDraft } from '@renderer/context/drafts-context'
import { BrowserInputRequestItem } from './browser-input-request-item'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

// Probe to read the shared session draft (renderWithProviders wraps DraftsProvider).
function DraftProbe({ sessionId }: { sessionId: string }) {
  const [value] = useDraft<string>(`session:${sessionId}`)
  return <div data-testid="draft-probe">{value ?? ''}</div>
}

const defaultProps = {
  toolUseId: 'tu-1',
  message: 'Complete the Cloudflare challenge',
  requirements: ['Solve the CAPTCHA', 'Click Log in'],
  sessionId: 's-1',
  agentSlug: 'my-agent',
  onComplete: vi.fn(),
}

const COMPLETE_URL = '/api/agents/my-agent/sessions/s-1/complete-browser-input'
const MESSAGES_URL = '/api/agents/my-agent/sessions/s-1/messages'

describe('BrowserInputRequestItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders Decline and Done buttons', () => {
    render(<BrowserInputRequestItem {...defaultProps} />)
    expect(screen.getByTestId('browser-input-decline-btn')).toBeInTheDocument()
    expect(screen.getByTestId('browser-input-complete-btn')).toBeInTheDocument()
  })

  it('decline with no reason → one call to complete-browser-input, no message, shows Declined', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    render(<BrowserInputRequestItem {...defaultProps} />)
    await user.click(screen.getByTestId('browser-input-decline-btn'))

    await waitFor(() => expect(screen.getByText('Declined')).toBeInTheDocument())
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockApiFetch.mock.calls[0]
    expect(url).toBe(COMPLETE_URL)
    expect(opts.body).toContain('"decline":true')
    expect(opts.body).not.toContain('declineReason') // reason travels via /messages, not the decline body
    expect(defaultProps.onComplete).toHaveBeenCalled()
  })

  it('decline with a typed reason → declines then posts the reason to /messages, in order', async () => {
    const user = userEvent.setup()
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: () => ({}) }) // complete-browser-input
      .mockResolvedValueOnce({ ok: true, json: () => ({}) }) // messages

    render(<BrowserInputRequestItem {...defaultProps} />)
    await user.click(screen.getByTestId('browser-input-decline-btn-chevron'))
    const textarea = await screen.findByPlaceholderText('Reason for declining...')
    await user.type(textarea, 'Skip the login, the data is public at /api/x{Enter}')

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2))
    expect(mockApiFetch.mock.calls[0][0]).toBe(COMPLETE_URL)
    expect(mockApiFetch.mock.calls[0][1].body).toContain('"decline":true')
    expect(mockApiFetch.mock.calls[1][0]).toBe(MESSAGES_URL)
    expect(mockApiFetch.mock.calls[1][1].body).toContain('Skip the login, the data is public at /api/x')
  })

  // NOTE: with onComplete mocked as a no-op the item stays mounted, so the error
  // banner is assertable here. In production onComplete removes the request and
  // unmounts the item, so the banner is best-effort; the draft-probe assertion below
  // is the load-bearing one — the preserved composer draft is the durable recovery.
  it('decline with reason where the message send fails → surfaces error and preserves the reason in the composer draft', async () => {
    const user = userEvent.setup()
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: () => ({}) })                       // decline ok
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: 'boom' }) }) // messages fail

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
    expect(screen.getByTestId('draft-probe')).toHaveTextContent('Skip the login')
  })

  it('completes (Done) without declining', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    render(<BrowserInputRequestItem {...defaultProps} />)
    await user.click(screen.getByTestId('browser-input-complete-btn'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1)
      const body = mockApiFetch.mock.calls[0][1].body as string
      expect(body).toContain('"toolUseId":"tu-1"')
      expect(body).not.toContain('"decline":true')
    })
  })
})
