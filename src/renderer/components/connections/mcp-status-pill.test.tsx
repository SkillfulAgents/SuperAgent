// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { McpStatusPill } from './mcp-status-pill'

describe('McpStatusPill', () => {
  it('renders nothing when status is active', () => {
    const { container } = render(<McpStatusPill status="active" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when status is undefined (non-MCP row)', () => {
    const { container } = render(<McpStatusPill status={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when status is null', () => {
    const { container } = render(<McpStatusPill status={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders Error label for status=error', () => {
    render(<McpStatusPill status="error" />)
    expect(screen.getByText('Error')).toBeInTheDocument()
  })

  it('renders Re-auth needed label for status=auth_required', () => {
    render(<McpStatusPill status="auth_required" />)
    expect(screen.getByText('Re-auth needed')).toBeInTheDocument()
  })

  it('shows error-specific tooltip headline on hover', async () => {
    const user = userEvent.setup()
    render(<McpStatusPill status="error" errorMessage="ECONNREFUSED 127.0.0.1:443" />)

    await user.hover(screen.getByText('Error'))

    // Radix tooltip portals two copies (visible + screen-reader); use getAllByText.
    expect((await screen.findAllByText('Connection failed')).length).toBeGreaterThan(0)
    expect((await screen.findAllByText('ECONNREFUSED 127.0.0.1:443')).length).toBeGreaterThan(0)
  })

  it('shows auth-specific tooltip headline on hover', async () => {
    const user = userEvent.setup()
    render(<McpStatusPill status="auth_required" />)

    await user.hover(screen.getByText('Re-auth needed'))

    expect((await screen.findAllByText('Re-authenticate to restore access')).length).toBeGreaterThan(0)
  })

  it('omits the error message line when errorMessage is empty', async () => {
    const user = userEvent.setup()
    render(<McpStatusPill status="error" errorMessage="" />)

    await user.hover(screen.getByText('Error'))

    expect((await screen.findAllByText('Connection failed')).length).toBeGreaterThan(0)
    // The empty-string message shouldn't appear as a separate line.
    const empties = screen.queryAllByText('')
    // Just assert no element with role=tooltip contains a second non-empty child;
    // simpler: assert there's only one visible <div> in the tooltip body besides the headline.
    const tooltips = screen.queryAllByRole('tooltip')
    if (tooltips.length > 0) {
      const childDivs = tooltips[0].querySelectorAll('div')
      expect(childDivs.length).toBe(1)
    }
    void empties
  })

  it('omits the error message line when errorMessage is whitespace-only', async () => {
    const user = userEvent.setup()
    render(<McpStatusPill status="error" errorMessage="   " />)

    await user.hover(screen.getByText('Error'))

    const tooltips = await screen.findAllByRole('tooltip')
    expect(tooltips.length).toBeGreaterThan(0)
    const childDivs = tooltips[0].querySelectorAll('div')
    expect(childDivs.length).toBe(1)
  })
})
