// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@renderer/lib/api'
import { XAgentReviewRequestItem } from './request'

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
          fileTransfer: { kind: 'send', paths: ['/workspace/reports/a.pdf', '/workspace/data/b.csv'] },
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

  it.each([false, true])('identifies the delivered file in a download review (readOnly=%s)', (readOnly) => {
    render(
      <XAgentReviewRequestItem
        reviewId="review-3"
        readOnly={readOnly}
        agentSlug="caller"
        xAgent={{
          targetAgentSlug: 'target',
          targetAgentName: 'Target Agent',
          operation: 'read',
          fileTransfer: { kind: 'download', filename: 'report.pdf' },
        }}
        onComplete={vi.fn()}
      />,
    )

    expect(screen.getByText(/download a delivered file/)).toBeInTheDocument()
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
    expect(screen.queryByTestId('xagent-review-allow-menu')).not.toBeInTheDocument()
  })
})

describe('XAgentReviewRequestItem "Always allow" over a Block', () => {
  it('says why on the card, then ends the request with Allow Once', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(apiFetch).mockReset()
      vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Forbidden: this agent link is blocked', blocked: true }), { status: 403 }))
      vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
      const onComplete = vi.fn()
      render(<XAgentReviewRequestItem reviewId="review-9" agentSlug="caller" xAgent={{ targetAgentSlug: 'target', targetAgentName: 'Target Agent', operation: 'invoke' }} onComplete={onComplete} />)
      fireEvent.click(screen.getByTestId('xagent-review-allow-menu'))
      await act(async () => { fireEvent.click(screen.getByTestId('xagent-review-always-invoke')) })
      expect(screen.getByTestId('xagent-review-completed')).toHaveTextContent('Blocked by policy')
      expect(apiFetch).toHaveBeenCalledTimes(1)
      await act(async () => { vi.advanceTimersByTime(2000) })
      expect(vi.mocked(apiFetch).mock.calls[1]).toEqual(['/api/agents/caller/proxy-review/review-9', expect.objectContaining({ body: JSON.stringify({ decision: 'allow' }) })])
      expect(onComplete).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  const card = (onComplete = vi.fn()) => render(<XAgentReviewRequestItem reviewId="review-9" agentSlug="caller" xAgent={{ targetAgentSlug: 'target', targetAgentName: 'Target Agent', operation: 'invoke' }} onComplete={onComplete} />)
  const clickAlways = async () => {
    fireEvent.click(screen.getByTestId('xagent-review-allow-menu'))
    await act(async () => { fireEvent.click(screen.getByTestId('xagent-review-always-invoke')) })
  }

  it('still ends the request, once, when the card goes away before the delay', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(apiFetch).mockReset()
      vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Forbidden: this agent link is blocked', blocked: true }), { status: 403 }))
      vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
      const { unmount } = card()
      await clickAlways()
      unmount()
      await act(async () => { vi.advanceTimersByTime(2000) })
      expect(apiFetch).toHaveBeenCalledTimes(2)
      expect(vi.mocked(apiFetch).mock.calls[1]).toEqual(['/api/agents/caller/proxy-review/review-9', expect.objectContaining({ body: JSON.stringify({ decision: 'allow' }) })])
    } finally {
      vi.useRealTimers()
    }
  })

  it('still ends the request when the card goes away before the Block answer arrives', async () => {
    vi.mocked(apiFetch).mockReset()
    let answer: (r: Response) => void = () => {}
    vi.mocked(apiFetch).mockReturnValueOnce(new Promise<Response>((resolve) => { answer = resolve }))
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
    const { unmount } = card()
    fireEvent.click(screen.getByTestId('xagent-review-allow-menu'))
    fireEvent.click(screen.getByTestId('xagent-review-always-invoke'))
    unmount()
    await act(async () => { answer(new Response(JSON.stringify({ error: 'Forbidden: this agent link is blocked', blocked: true }), { status: 403 })) })
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(apiFetch).mock.calls[1]).toEqual(['/api/agents/caller/proxy-review/review-9', expect.objectContaining({ body: JSON.stringify({ decision: 'allow' }) })])
  })

  it('shows any other refusal inline and keeps the card open', async () => {
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }))
    card()
    await clickAlways()
    expect(screen.getByText('Error: Forbidden')).toBeInTheDocument()
    expect(screen.queryByTestId('xagent-review-completed')).not.toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})
