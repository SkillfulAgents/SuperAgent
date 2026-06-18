// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import { BrowserInputRequestItem } from './browser-input-request-item'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))

const baseProps = {
  toolUseId: 'tu-1',
  message: 'Log in to the dashboard',
  sessionId: 's-1',
  agentSlug: 'agent-1',
  onComplete: vi.fn(),
}

describe('BrowserInputRequestItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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
