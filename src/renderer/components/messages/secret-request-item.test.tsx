// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SecretRequestItem } from './secret-request-item'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const defaultProps = {
  toolUseId: 'tu-1',
  secretName: 'OPENAI_API_KEY',
  reason: 'Needed for embeddings',
  sessionId: 's-1',
  agentSlug: 'my-agent',
  onComplete: vi.fn(),
}

describe('SecretRequestItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders pending state with secret name and reason', () => {
    render(<SecretRequestItem {...defaultProps} />)
    expect(screen.getByText('OPENAI_API_KEY')).toBeInTheDocument()
    expect(screen.getByText('Needed for embeddings')).toBeInTheDocument()
    expect(screen.getByText('Provide')).toBeInTheDocument()
    expect(screen.getByText('Decline')).toBeInTheDocument()
  })

  it('has password input by default', () => {
    render(<SecretRequestItem {...defaultProps} />)
    const input = screen.getByPlaceholderText('Enter secret value...')
    expect(input).toHaveAttribute('type', 'password')
  })

  it('toggles visibility of secret value', async () => {
    const user = userEvent.setup()
    render(<SecretRequestItem {...defaultProps} />)

    const input = screen.getByPlaceholderText('Enter secret value...')
    expect(input).toHaveAttribute('type', 'password')

    // Click the toggle button (eye icon)
    const toggleButtons = screen.getAllByRole('button')
    const eyeButton = toggleButtons.find(b => !b.textContent?.includes('Provide') && !b.textContent?.includes('Decline'))!
    await user.click(eyeButton)
    expect(input).toHaveAttribute('type', 'text')
  })

  it('provides secret on submit', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    render(<SecretRequestItem {...defaultProps} />)

    const input = screen.getByPlaceholderText('Enter secret value...')
    await user.type(input, 'sk-test-123')
    await user.click(screen.getByText('Provide'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/my-agent/sessions/s-1/provide-secret',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('sk-test-123'),
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Provided')).toBeInTheDocument()
    })
    expect(defaultProps.onComplete).toHaveBeenCalled()
  })

  it('declines secret request', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    render(<SecretRequestItem {...defaultProps} />)

    await user.click(screen.getByText('Decline'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/my-agent/sessions/s-1/provide-secret',
        expect.objectContaining({
          body: expect.stringContaining('"decline":true'),
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Declined')).toBeInTheDocument()
    })
    expect(defaultProps.onComplete).toHaveBeenCalled()
  })

  it('shows error on API failure and reverts to pending', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Server error' }),
    })

    render(<SecretRequestItem {...defaultProps} />)

    const input = screen.getByPlaceholderText('Enter secret value...')
    await user.type(input, 'sk-test')
    await user.click(screen.getByText('Provide'))

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument()
    })
    // Should still be in pending state (form still visible)
    expect(screen.getByText('Provide')).toBeInTheDocument()
  })

  it('provide button is disabled when input is empty', () => {
    render(<SecretRequestItem {...defaultProps} />)
    const provideButton = screen.getByText('Provide').closest('button')!
    expect(provideButton).toBeDisabled()
  })

  it('submits on Enter key in input', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    render(<SecretRequestItem {...defaultProps} />)

    const input = screen.getByPlaceholderText('Enter secret value...')
    await user.type(input, 'sk-test{Enter}')

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalled()
    })
  })
})
