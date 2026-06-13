// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AccountStatusBadge } from './account-status-badge'

describe('AccountStatusBadge', () => {
  it('renders nothing for active status', () => {
    const { container } = render(<AccountStatusBadge status="active" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when status is null', () => {
    const { container } = render(<AccountStatusBadge status={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when status is undefined', () => {
    const { container } = render(<AccountStatusBadge />)
    expect(container.firstChild).toBeNull()
  })

  it('renders "Expired" badge for expired status', () => {
    render(<AccountStatusBadge status="expired" />)
    expect(screen.getByText('Expired')).toBeInTheDocument()
  })

  it('renders "Revoked" badge for revoked status', () => {
    render(<AccountStatusBadge status="revoked" />)
    expect(screen.getByText('Revoked')).toBeInTheDocument()
  })
})
