// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { deliverFileRenderer } from './deliver-file'

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ openFile: vi.fn() }),
}))

vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: () => 'http://api.test',
}))

// Optional on the ToolRenderer interface; this renderer always defines it.
const ExpandedView = deliverFileRenderer.ExpandedView!
const RESULT = 'File "output/report.pdf" (12345 bytes) has been delivered.\n\nDelivered: {"sizeBytes":12345}'

describe('deliver_file expanded view', () => {
  it('renders the same delivery row the turn shows, with the size from the result', () => {
    render(
      <ExpandedView
        input={{ filePath: '/workspace/output/report.pdf', description: 'Quarterly report' }}
        result={RESULT}
        agentSlug="test-agent"
      />
    )
    const row = screen.getByTestId('file-delivery-row')
    expect(row).toHaveTextContent('report.pdf')
    expect(screen.getByTestId('file-delivery-meta')).toHaveTextContent('Quarterly report · 12.1 KB')
    // a pdf previews, so the row points at the drawer rather than offering a download
    expect(row).toHaveAttribute('data-file-action', 'preview')
  })

  it('offers a download for a file the drawer cannot render', () => {
    render(
      <ExpandedView
        input={{ filePath: '/workspace/output/bundle.zip' }}
        result={'Delivered: {"sizeBytes":8192}'}
        agentSlug="test-agent"
      />
    )
    expect(screen.getByTestId('file-delivery-row')).toHaveAttribute('data-file-action', 'download')
    expect(screen.getByRole('link', { name: 'Download bundle.zip' })).toBeInTheDocument()
  })

  it('falls back to a plain name for a failed delivery, with no row to click', () => {
    render(
      <ExpandedView
        input={{ filePath: '/workspace/output/missing.pdf', description: 'Nope' }}
        result="Error: File not found at /workspace/output/missing.pdf"
        isError
        agentSlug="test-agent"
      />
    )
    expect(screen.queryByTestId('file-delivery-row')).not.toBeInTheDocument()
    expect(screen.getByText('missing.pdf')).toBeInTheDocument()
    expect(screen.getByText('Nope')).toBeInTheDocument()
  })
})
