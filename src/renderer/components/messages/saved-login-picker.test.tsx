// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SavedLoginPicker } from './saved-login-picker'

const savedLogins = {
  logins: [{ id: 'bc-1', name: 'linkedin.com', site: 'linkedin.com', capturedAt: '2026-09-20T22:14:00.000Z' }],
  applyingId: null,
  applied: false,
  settled: false,
  error: null,
  apply: vi.fn(),
}

describe('SavedLoginPicker', () => {
  it('says other members of a shared agent can use the login', () => {
    render(<SavedLoginPicker savedLogins={savedLogins} otherMembers={1} />)
    expect(screen.getByTestId('saved-login-shared-notice')).toHaveTextContent(
      '1 other member can use this agent. It will stay signed in to linkedin.com with your account. The saved login may also include other sites you signed in to along the way.',
    )
  })

  it('shows no notice when only the user can use the agent', () => {
    render(<SavedLoginPicker savedLogins={savedLogins} otherMembers={0} />)
    expect(screen.queryByTestId('saved-login-shared-notice')).toBeNull()
  })

  it('cannot apply until the member count is known, then acknowledges the notice it showed', async () => {
    const apply = vi.fn()
    const { rerender } = render(<SavedLoginPicker savedLogins={{ ...savedLogins, apply }} otherMembers={null} />)
    expect(screen.getByTestId('saved-login-bc-1')).toBeDisabled()
    expect(screen.queryByTestId('saved-login-shared-notice')).toBeNull()

    rerender(<SavedLoginPicker savedLogins={{ ...savedLogins, apply }} otherMembers={2} />)
    await userEvent.click(screen.getByTestId('saved-login-bc-1'))
    expect(apply).toHaveBeenCalledWith('bc-1', true)
  })

  it('does not claim the agent will check the login when the request is still open', () => {
    render(<SavedLoginPicker savedLogins={{ ...savedLogins, applied: true, settled: false, error: 'Saved login applied, but the agent was not told. Click Done to continue.' }} otherMembers={0} />)
    expect(screen.queryByText(/The agent will check/)).toBeNull()
    expect(screen.queryByTestId('saved-login-bc-1')).toBeNull()
    expect(screen.getByText('Saved login applied, but the agent was not told. Click Done to continue.')).toBeInTheDocument()
  })
})
