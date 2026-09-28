// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SavedLoginPicker } from './saved-login-picker'

const savedLogins = {
  logins: [{ id: 'bc-1', name: 'linkedin.com', site: 'linkedin.com', capturedAt: '2026-09-20T22:14:00.000Z' }],
  applyingId: null,
  applied: false,
  error: null,
  apply: vi.fn(),
}

describe('SavedLoginPicker', () => {
  it('says other members of a shared agent can use the login', () => {
    render(<SavedLoginPicker savedLogins={savedLogins} otherMembers={1} />)
    expect(screen.getByTestId('saved-login-shared-notice')).toHaveTextContent(
      '1 other member can use this agent. It will stay signed in to linkedin.com with your account.',
    )
  })

  it('shows no notice when only the user can use the agent', () => {
    render(<SavedLoginPicker savedLogins={savedLogins} />)
    expect(screen.queryByTestId('saved-login-shared-notice')).toBeNull()
  })
})
