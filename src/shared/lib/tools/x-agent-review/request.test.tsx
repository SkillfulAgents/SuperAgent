// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@renderer/lib/api'
import type { XAgentReview } from '@shared/lib/proxy/x-agent-review'
import { XAgentReviewRequestItem } from './request'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

// The composer's picker, reduced to one choice: it reads connections through react-query in the app.
// It snaps effort to the model on mount, as the real one does when a model lacks it, and swaps a
// model the viewer's plan locks ('locked') for another, as the real one does.
vi.mock('@renderer/components/messages/composer-options', async () => {
  const { useEffect, useState } = await import('react')
  return {
    useComposerOptions: ({ initial: { model: initialModel, llmProviderId: initialConnection, effort: initialEffort, speed: initialSpeed } = {}, connectionsPath }: { initial?: { model?: string; llmProviderId?: string; effort?: string; speed?: string }; connectionsPath?: string }) => {
      mockConnectionsPath = connectionsPath
      const [model, setModel] = useState(initialModel === 'locked' ? 'claude-haiku-5-5' : initialModel)
      const [llmProviderId, setConnection] = useState(initialConnection)
      const [effort, setEffort] = useState(initialEffort)
      const [speed, setSpeed] = useState(initialSpeed)
      // 'loading': the card's connection has not arrived yet.
      return { model, setModel, llmProviderId, setConnection, effort, setEffort, speed, setSpeed, connections: initialConnection === 'loading' ? [] : [{ id: initialConnection }, { id: 'mine' }], ...(initialConnection === 'moved' ? { llmProviderId: 'mine' } : {}) }
    },
    ComposerOptions: ({ state, onUserChange }: { state: { model?: string; setModel: (model: string) => void; setConnection: (id: string) => void; setEffort: (effort: string) => void }; onUserChange?: () => void }) => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
      useEffect(() => { state.setEffort('high') }, [])
      return (
        <>
          <button type="button" data-testid="picker" onClick={() => { onUserChange?.(); state.setModel('claude-opus-5-5') }}>{state.model}</button>
          <button type="button" data-testid="picker-account" onClick={() => { onUserChange?.(); state.setConnection('mine') }}>account</button>
          <button type="button" data-testid="picker-account-back" onClick={() => { onUserChange?.(); state.setConnection('platform') }}>back</button>
        </>
      )
    },
  }
})

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(),
}))

let mockConnectionsPath: string | undefined
let mockUser: { isAuthMode: boolean; rolesReady: boolean; canUseAgent: (slug: string) => boolean } = { isAuthMode: false, rolesReady: true, canUseAgent: () => true }
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => mockUser,
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
    expect(screen.getByTestId('xagent-review-always-allow-btn')).toBeInTheDocument()
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
    if (readOnly) expect(screen.queryByTestId('xagent-review-always-allow-btn')).not.toBeInTheDocument()
    else expect(screen.getByTestId('xagent-review-always-allow-btn')).toBeInTheDocument()
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
      fireEvent.click(screen.getByTestId('xagent-review-always-allow-btn'))
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
    fireEvent.click(screen.getByTestId('xagent-review-always-allow-btn'))
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
    fireEvent.click(screen.getByTestId('xagent-review-always-allow-btn'))
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

describe('XAgentReviewRequestItem buttons', () => {
  it('sit in the fixed footer and send a typed deny reason', async () => {
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
    render(<XAgentReviewRequestItem reviewId="review-7" agentSlug="caller" xAgent={{ targetAgentSlug: 'target', targetAgentName: 'Target Agent', operation: 'read' }} onComplete={vi.fn()} />)
    expect(screen.getByTestId('xagent-review-deny-btn').closest('[data-request-item-body]')).toBeNull()
    fireEvent.click(screen.getByTestId('xagent-review-deny-btn-chevron'))
    const input = await screen.findByTestId('xagent-review-deny-btn-reason-input')
    fireEvent.change(input, { target: { value: 'wrong agent' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(vi.mocked(apiFetch).mock.calls[0]).toEqual(['/api/agents/caller/proxy-review/review-7', expect.objectContaining({ body: JSON.stringify({ decision: 'deny', reason: 'wrong agent' }) })])
  })
})

describe('XAgentReviewRequestItem model', () => {
  const invokeCard: XAgentReview = { targetAgentSlug: 'target', targetAgentName: 'Target Agent', operation: 'invoke', runtime: { model: 'sonnet', llmProviderId: 'platform', effort: 'xhigh', speed: 'fast', label: 'Sonnet 5.5' } }
  const postedBody = () => JSON.parse(String((vi.mocked(apiFetch).mock.calls[0][1] as RequestInit).body))
  afterEach(() => { mockUser = { isAuthMode: false, rolesReady: true, canUseAgent: () => true } })

  it('names the model, effort and speed in the button row for someone who cannot allow', () => {
    mockUser = { isAuthMode: true, rolesReady: true, canUseAgent: (slug) => slug === 'caller' }
    render(<XAgentReviewRequestItem reviewId="review-8" agentSlug="caller" xAgent={invokeCard} onComplete={vi.fn()} />)
    const line = screen.getByTestId('xagent-review-model')
    expect(line).toHaveTextContent('Model: Sonnet 5.5 · Extra High · Fast')
    expect(line.closest('[data-request-item-actions]')).not.toBeNull()
    expect(screen.queryByTestId('picker')).toBeNull()
  })

  it('offers whoever can allow the picker, and an untouched Allow sends no model after its snap or a Tab through it', async () => {
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
    render(<XAgentReviewRequestItem reviewId="review-8" agentSlug="caller" xAgent={invokeCard} onComplete={vi.fn()} />)
    expect(screen.getByTestId('picker')).toHaveTextContent('sonnet')
    fireEvent.keyDown(screen.getByTestId('picker'), { key: 'Tab' })
    fireEvent.pointerDown(screen.getByTestId('picker'))
    await act(async () => { fireEvent.click(screen.getByTestId('xagent-review-allow-once-btn')) })
    expect(postedBody()).toEqual({ decision: 'allow' })
  })

  it.each([
    { name: 'until the card\'s connection has loaded', runtime: { llmProviderId: 'loading' } },
    { name: 'when the viewer\'s plan would swap the model that runs', runtime: { model: 'locked' } },
    { name: 'when the picker would show the same model on another account', runtime: { llmProviderId: 'moved' } },
  ])('shows the line, not the picker, $name', ({ runtime }) => {
    render(<XAgentReviewRequestItem reviewId="review-8" agentSlug="caller" xAgent={{ ...invokeCard, runtime: { ...invokeCard.runtime!, ...runtime } }} onComplete={vi.fn()} />)
    expect(screen.queryByTestId('picker')).toBeNull()
    expect(screen.getByTestId('xagent-review-model')).toHaveTextContent('Model: Sonnet 5.5')
  })

  it('sends the model picked on the card with the allow', async () => {
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
    render(<XAgentReviewRequestItem reviewId="review-8" agentSlug="caller" xAgent={invokeCard} onComplete={vi.fn()} />)
    fireEvent.click(screen.getByTestId('picker'))
    await act(async () => { fireEvent.click(screen.getByTestId('xagent-review-allow-once-btn')) })
    expect(postedBody()).toEqual({ decision: 'allow', pick: { model: 'claude-opus-5-5', llmProviderId: 'platform', effort: 'high', speed: 'fast' } })
  })

  it("offers the viewer's accounts plus the card's, and sends another account picked on the card", async () => {
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
    render(<XAgentReviewRequestItem reviewId="review-8" agentSlug="caller" xAgent={invokeCard} onComplete={vi.fn()} />)
    expect(mockConnectionsPath).toBe('/api/agents/caller/proxy-review/review-8/llm-connections')
    fireEvent.click(screen.getByTestId('picker-account'))
    await act(async () => { fireEvent.click(screen.getByTestId('xagent-review-allow-once-btn')) })
    expect(postedBody()).toEqual({ decision: 'allow', pick: { model: 'sonnet', llmProviderId: 'mine', effort: 'high', speed: 'fast' } })
  })

  it('sends the account last picked when the approver switches account twice', async () => {
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
    render(<XAgentReviewRequestItem reviewId="review-8" agentSlug="caller" xAgent={invokeCard} onComplete={vi.fn()} />)
    fireEvent.click(screen.getByTestId('picker-account'))
    fireEvent.click(screen.getByTestId('picker-account-back'))
    await act(async () => { fireEvent.click(screen.getByTestId('xagent-review-allow-once-btn')) })
    expect(postedBody().pick.llmProviderId).toBe('platform')
  })

  it('names the account beside the model when the card has one', () => {
    mockUser = { isAuthMode: true, rolesReady: true, canUseAgent: (slug) => slug === 'caller' }
    render(<XAgentReviewRequestItem reviewId="review-8" agentSlug="caller" xAgent={{ ...invokeCard, runtime: { ...invokeCard.runtime!, account: 'ChatGPT' } }} onComplete={vi.fn()} />)
    expect(screen.getByTestId('xagent-review-model')).toHaveTextContent('Model: Sonnet 5.5 (ChatGPT) · Extra High · Fast')
  })

  it('drops a refused pick, so the next Allow runs the card\'s model', async () => {
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "That model isn't available to this agent. Pick another one." }), { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    render(<XAgentReviewRequestItem reviewId="review-8" agentSlug="caller" xAgent={invokeCard} onComplete={vi.fn()} />)
    fireEvent.click(screen.getByTestId('picker'))
    await act(async () => { fireEvent.click(screen.getByTestId('xagent-review-allow-once-btn')) })
    expect(screen.getByText("Error: That model isn't available to this agent. Pick another one.")).toBeInTheDocument()
    expect(screen.getByTestId('picker')).toHaveTextContent('sonnet')
    await act(async () => { fireEvent.click(screen.getByTestId('xagent-review-allow-once-btn')) })
    expect(JSON.parse(String((vi.mocked(apiFetch).mock.calls[1][1] as RequestInit).body))).toEqual({ decision: 'allow' })
  })

  it('names no model on a card without one', () => {
    render(<XAgentReviewRequestItem reviewId="review-9" agentSlug="caller" xAgent={{ targetAgentSlug: 'target', targetAgentName: 'Target Agent', operation: 'invoke' }} onComplete={vi.fn()} />)
    expect(screen.queryByTestId('xagent-review-model')).toBeNull()
  })
})

describe('XAgentReviewRequestItem in a team workspace', () => {
  afterEach(() => { mockUser = { isAuthMode: false, rolesReady: true, canUseAgent: () => true } })
  // The parent renders the card read-only for a Viewer of the calling agent.
  const readCard: XAgentReview = { targetAgentSlug: 'target', targetAgentName: 'Target Agent', operation: 'read' }
  const card = (uses: string[], rolesReady = true) => {
    mockUser = { isAuthMode: true, rolesReady, canUseAgent: (slug) => uses.includes(slug) }
    render(<XAgentReviewRequestItem reviewId="review-10" agentSlug="caller" readOnly={!uses.includes('caller')} xAgent={readCard} onComplete={vi.fn()} />)
  }

  it('shows a Viewer of both the read-only card and which agents they need User access to', () => {
    card([])
    expect(screen.getByText('You need User access to this agent and Target Agent to allow this.')).toBeInTheDocument()
    expect(screen.queryByTestId('xagent-review-deny-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('xagent-review-allow-once-btn')).not.toBeInTheDocument()
  })

  it('offers someone who uses only the calling agent Deny, no Allow, and names the target', () => {
    card(['caller'])
    expect(screen.getByText('You need User access to Target Agent to allow this.')).toBeInTheDocument()
    expect(screen.getByTestId('xagent-review-deny-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('xagent-review-allow-once-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('xagent-review-always-allow-btn')).not.toBeInTheDocument()
  })

  it('offers no Allow, and no line, while roles load', () => {
    card(['caller', 'target'], false)
    expect(screen.getByTestId('xagent-review-deny-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('xagent-review-allow-once-btn')).not.toBeInTheDocument()
    expect(screen.queryByText(/You need User access/)).not.toBeInTheDocument()
  })

  it('offers someone who uses both the full bar and no line', () => {
    card(['caller', 'target'])
    expect(screen.getByTestId('xagent-review-deny-btn')).toBeInTheDocument()
    expect(screen.getByTestId('xagent-review-allow-once-btn')).toBeInTheDocument()
    expect(screen.getByTestId('xagent-review-always-allow-btn')).toBeInTheDocument()
    expect(screen.queryByText(/You need User access/)).not.toBeInTheDocument()
  })
})
