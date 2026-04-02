// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScriptRunRequestItem } from './script-run-request-item'

// Mock apiFetch
const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const defaultProps = {
  toolUseId: 'tool-1',
  script: 'sw_vers',
  explanation: 'Check macOS version',
  scriptType: 'shell' as const,
  sessionId: 'session-1',
  agentSlug: 'agent-1',
  onComplete: vi.fn(),
}

describe('ScriptRunRequestItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders script content and explanation', () => {
    render(<ScriptRunRequestItem {...defaultProps} />)

    expect(screen.getByText('Check macOS version')).toBeInTheDocument()
    expect(screen.getByText('sw_vers')).toBeInTheDocument()
    expect(screen.getByText('Shell')).toBeInTheDocument()
  })

  it('renders script type badge for applescript', () => {
    render(<ScriptRunRequestItem {...defaultProps} scriptType="applescript" />)
    expect(screen.getByText('AppleScript')).toBeInTheDocument()
  })

  it('renders script type badge for powershell', () => {
    render(<ScriptRunRequestItem {...defaultProps} scriptType="powershell" />)
    expect(screen.getByText('PowerShell')).toBeInTheDocument()
  })

  it('calls API with correct payload on Allow Once click', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })

    render(<ScriptRunRequestItem {...defaultProps} />)

    await user.click(screen.getByTestId('script-run-once-btn'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/agent-1/sessions/session-1/run-script',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            toolUseId: 'tool-1',
            script: 'sw_vers',
            scriptType: 'shell',
            grantType: 'once',
          }),
        })
      )
    })
  })

  it('calls onComplete after successful Allow Once', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })

    render(<ScriptRunRequestItem {...defaultProps} />)

    await user.click(screen.getByTestId('script-run-once-btn'))

    await waitFor(() => {
      expect(defaultProps.onComplete).toHaveBeenCalled()
    })
  })

  it('shows executed state after successful approval', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })

    render(<ScriptRunRequestItem {...defaultProps} />)

    await user.click(screen.getByTestId('script-run-once-btn'))

    await waitFor(() => {
      expect(screen.getByText('Executed')).toBeInTheDocument()
    })
  })

  it('calls API with Allow 15 min grant type', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })

    render(<ScriptRunRequestItem {...defaultProps} />)

    // Open the popover first, then click "Allow 15 min"
    await user.click(screen.getByTestId('script-run-timed-btn-chevron'))
    await user.click(screen.getByTestId('script-run-timed-btn'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/agent-1/sessions/session-1/run-script',
        expect.objectContaining({
          body: expect.stringContaining('"grantType":"timed"'),
        })
      )
    })
  })

  it('calls API with Always Allow grant type', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })

    render(<ScriptRunRequestItem {...defaultProps} />)

    // Open the popover first, then click "Always Allow"
    await user.click(screen.getByTestId('script-run-timed-btn-chevron'))
    await user.click(screen.getByTestId('script-run-always-btn'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/agent-1/sessions/session-1/run-script',
        expect.objectContaining({
          body: expect.stringContaining('"grantType":"always"'),
        })
      )
    })
  })

  it('calls API with decline payload on Deny click', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })

    render(<ScriptRunRequestItem {...defaultProps} />)

    // The DeclineButton main button calls onDecline() with no reason
    await user.click(screen.getByTestId('script-deny-btn'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/agent-1/sessions/session-1/run-script',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            toolUseId: 'tool-1',
            decline: true,
            declineReason: 'User denied script execution',
          }),
        })
      )
    })
  })

  it('shows denied state after successful Deny', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })

    render(<ScriptRunRequestItem {...defaultProps} />)

    await user.click(screen.getByTestId('script-deny-btn'))

    await waitFor(() => {
      expect(screen.getByText('Denied')).toBeInTheDocument()
    })
  })

  it('calls onComplete after successful Deny', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })

    render(<ScriptRunRequestItem {...defaultProps} />)

    await user.click(screen.getByTestId('script-deny-btn'))

    await waitFor(() => {
      expect(defaultProps.onComplete).toHaveBeenCalled()
    })
  })

  it('shows error on API failure for Allow Once and returns to pending', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: 'Server error' }) })

    render(<ScriptRunRequestItem {...defaultProps} />)

    await user.click(screen.getByTestId('script-run-once-btn'))

    await waitFor(() => {
      expect(screen.getByText(/Server error/)).toBeInTheDocument()
    })

    // Should still show the Allow Once button (back to pending)
    expect(screen.getByTestId('script-run-once-btn')).toBeInTheDocument()
  })

  it('shows error on API failure for Deny and returns to pending', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: 'Deny failed' }) })

    render(<ScriptRunRequestItem {...defaultProps} />)

    await user.click(screen.getByTestId('script-deny-btn'))

    await waitFor(() => {
      expect(screen.getByText(/Deny failed/)).toBeInTheDocument()
    })

    // Should still show both buttons (back to pending)
    expect(screen.getByTestId('script-deny-btn')).toBeInTheDocument()
  })

  it('renders read-only state without action buttons', () => {
    render(<ScriptRunRequestItem {...defaultProps} readOnly />)

    expect(screen.getByText('Waiting for approval')).toBeInTheDocument()
    expect(screen.queryByTestId('script-run-once-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('script-deny-btn')).not.toBeInTheDocument()
  })

  it('shows security warning text', () => {
    render(<ScriptRunRequestItem {...defaultProps} />)

    expect(screen.getByText(/actual computer with your user permissions/)).toBeInTheDocument()
  })
})
