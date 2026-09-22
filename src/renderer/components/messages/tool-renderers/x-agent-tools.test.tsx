// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { getToolRenderer } from '.'
import { downloadAgentFileRenderer, invokeAgentRenderer } from './x-agent-tools'

describe('invoke_agent renderer', () => {
  it('shows the attachment count and source paths', () => {
    const ExpandedView = invokeAgentRenderer.ExpandedView!
    render(
      <ExpandedView
        input={{
          slug: 'reviewer',
          prompt: 'Review these files',
          attachments: ['/workspace/report.pdf', 'notes/context.txt'],
        }}
      />,
    )

    expect(screen.getByText('Attachments (2)')).toBeInTheDocument()
    expect(screen.getByText('/workspace/report.pdf')).toBeInTheDocument()
    expect(screen.getByText('notes/context.txt')).toBeInTheDocument()
  })

  it('handles malformed input without crashing', () => {
    const ExpandedView = invokeAgentRenderer.ExpandedView!
    expect(() => render(<ExpandedView input={{ attachments: 'not-an-array' }} />)).not.toThrow()
  })
})

describe('download_agent_file renderer', () => {
  it('is registered and shows target, session, delivery, and result', () => {
    expect(getToolRenderer('mcp__agents__download_agent_file')).toBe(downloadAgentFileRenderer)
    const ExpandedView = downloadAgentFileRenderer.ExpandedView!
    render(
      <ExpandedView
        input={{ slug: 'reviewer', session_id: 'session-123456789', delivery_id: 'delivery-987' }}
        result="Downloaded 42 bytes to /workspace/downloads/x-agent/reviewer/report.pdf"
      />,
    )

    expect(screen.getByText('Target:')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /reviewer/ })).toBeInTheDocument()
    expect(screen.getByText('· Session:')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /session-1234/ })).toBeInTheDocument()
    expect(screen.getByText('· Delivery:')).toBeInTheDocument()
    expect(screen.getByText('delivery-987')).toBeInTheDocument()
    expect(screen.getByText(/Downloaded 42 bytes/)).toBeInTheDocument()
  })

  it('renders placeholders for malformed input', () => {
    const ExpandedView = downloadAgentFileRenderer.ExpandedView!
    const { container } = render(<ExpandedView input={null} result="Failed to download agent file" isError />)

    expect(container).toHaveTextContent('Target:—· Session:—· Delivery:—')
    expect(screen.getByText('Failed to download agent file')).toHaveClass('text-red-800')
  })
})
