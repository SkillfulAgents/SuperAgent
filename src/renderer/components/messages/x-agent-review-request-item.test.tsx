// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { XAgentReviewRequestItem } from './x-agent-review-request-item'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(),
}))

describe('XAgentReviewRequestItem attachments', () => {
  it('discloses every caller-local file included in an invoke review', () => {
    render(
      <XAgentReviewRequestItem
        reviewId="review-1"
        agentSlug="caller"
        xAgent={{
          targetAgentSlug: 'target',
          targetAgentName: 'Target Agent',
          operation: 'invoke',
          preview: 'Compare these files',
          attachments: ['/workspace/reports/a.pdf', '/workspace/data/b.csv'],
        }}
        onComplete={vi.fn()}
      />,
    )

    expect(screen.getByText('2 files to share')).toBeInTheDocument()
    expect(screen.getByText('/workspace/reports/a.pdf')).toBeInTheDocument()
    expect(screen.getByText('/workspace/data/b.csv')).toBeInTheDocument()
    expect(screen.queryByTestId('xagent-review-allow-menu')).not.toBeInTheDocument()
  })

  it('keeps attachment disclosure in read-only session views', () => {
    render(
      <XAgentReviewRequestItem
        reviewId="review-2"
        agentSlug="caller"
        readOnly
        xAgent={{
          targetAgentSlug: 'target',
          targetAgentName: 'Target Agent',
          operation: 'invoke',
          preview: 'Share the report',
          attachments: ['/workspace/reports/long-report-name.pdf'],
        }}
        onComplete={vi.fn()}
      />,
    )

    expect(screen.getByText('Share the report')).toBeInTheDocument()
    expect(screen.getByText('1 file to share')).toBeInTheDocument()
    expect(screen.getByTitle('/workspace/reports/long-report-name.pdf')).toBeInTheDocument()
  })

  it('identifies the delivered file in a download review', () => {
    render(
      <XAgentReviewRequestItem
        reviewId="review-3"
        agentSlug="caller"
        xAgent={{
          targetAgentSlug: 'target',
          targetAgentName: 'Target Agent',
          operation: 'read',
          preview: 'download delivered file "report.pdf"',
        }}
        onComplete={vi.fn()}
      />,
    )

    expect(screen.getByText(/download a delivered file/)).toBeInTheDocument()
    expect(screen.getByText('download delivered file "report.pdf"')).toBeInTheDocument()
  })
})
