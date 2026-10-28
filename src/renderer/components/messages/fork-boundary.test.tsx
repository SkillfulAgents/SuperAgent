// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { ApiSession } from '@shared/lib/types/api'
import { createAssistantMessage, createCompactBoundary, createUserMessage } from '@renderer/test/factories'
import { ForkBoundaryItem, forkBoundaryIndex } from './fork-boundary'

const mocks = vi.hoisted(() => ({ session: null as Partial<ApiSession> | null }))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useSession: () => ({ data: mocks.session }),
}))

vi.mock('@renderer/components/ui/app-link', () => ({
  AppLink: ({
    children,
    params,
    'data-testid': testId,
  }: {
    children: ReactNode
    params: { slug: string; sessionId: string }
    'data-testid'?: string
  }) => <a href={`/agents/${params.slug}/sessions/${params.sessionId}`} data-testid={testId}>{children}</a>,
}))

describe('forkBoundaryIndex', () => {
  it('is null when nothing was copied by a fork', () => {
    expect(forkBoundaryIndex([])).toBeNull()
    expect(forkBoundaryIndex([createUserMessage(), createAssistantMessage()])).toBeNull()
  })

  it('points at the first item after the last copied message', () => {
    const items = [
      createUserMessage({ forked: true }),
      createAssistantMessage({ forked: true }),
      createUserMessage(),
      createAssistantMessage(),
    ]
    expect(forkBoundaryIndex(items)).toBe(2)
  })

  it('is the list length right after forking, before anything new', () => {
    const items = [createUserMessage({ forked: true }), createAssistantMessage({ forked: true })]
    expect(forkBoundaryIndex(items)).toBe(2)
  })

  it('sits before a compaction that ran in the copy', () => {
    // Fork & Summarize: the compact boundary is new, so the fork line goes above it.
    const items = [createUserMessage({ forked: true }), createCompactBoundary(), createUserMessage()]
    expect(forkBoundaryIndex(items)).toBe(1)
  })

  it('sits after a compaction the source ended on', () => {
    // Compact, then fork: the boundary was copied too, so the line goes below it.
    const items = [createUserMessage({ forked: true }), createCompactBoundary({ forked: true }), createUserMessage()]
    expect(forkBoundaryIndex(items)).toBe(2)
  })

  it('keeps new content below the line when a slot displays a copied item after a newer one', () => {
    // The list groups a slot's system items by type: a banner the source ended
    // on can render after a compaction that ran in the fork. The line still
    // goes above the compaction.
    const items = [
      createUserMessage({ forked: true }),
      createCompactBoundary(),
      { id: 'info-1', type: 'informational' as const, content: 'Stopped by hook', createdAt: new Date(), forked: true },
    ]
    expect(forkBoundaryIndex(items)).toBe(1)

    // The scroll window can open on that reordered slot, with the copied
    // message above it already hidden. The line still goes above the compaction.
    expect(forkBoundaryIndex(items.slice(1))).toBe(0)
  })
})

describe('ForkBoundaryItem', () => {
  it('names the source and links to it', () => {
    mocks.session = { forkedFromSessionId: 'src-1', forkedFromSessionName: 'Pricing' }
    render(<ForkBoundaryItem sessionId="fork-1" agentSlug="agent-a" />)

    expect(screen.getByTestId('fork-boundary')).toHaveTextContent('Branched from Pricing')
    expect(screen.getByTestId('fork-boundary-link')).toHaveAttribute('href', '/agents/agent-a/sessions/src-1')
  })

  it('degrades to plain text when the source is gone', () => {
    mocks.session = { forkedFromSessionId: 'src-1' }
    render(<ForkBoundaryItem sessionId="fork-1" agentSlug="agent-a" />)

    expect(screen.getByTestId('fork-boundary')).toHaveTextContent('Branched from a deleted conversation')
    expect(screen.queryByTestId('fork-boundary-link')).toBeNull()
  })

  it('draws nothing until the session has loaded, so "deleted" never flashes', () => {
    mocks.session = null
    render(<ForkBoundaryItem sessionId="fork-1" agentSlug="agent-a" />)

    expect(screen.queryByTestId('fork-boundary')).toBeNull()
  })
})
