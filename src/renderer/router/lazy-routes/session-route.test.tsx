// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionRoute } from './session-route'
import type { PendingMessagesContextValue } from '@renderer/context/pending-messages-context'

const mocks = vi.hoisted(() => ({
  sessionId: undefined as string | undefined,
  agentSlug: 'agent-1',
  created: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ sessionId: mocks.sessionId }) }))
vi.mock('./use-agent-slug', () => ({ useAgentSlug: () => mocks.agentSlug }))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: { slug: mocks.agentSlug } }) }))
vi.mock('@renderer/context/pending-messages-context', () => ({
  usePendingMessages: () => ({ onSessionCreated: mocks.created }),
}))
vi.mock('@renderer/components/layout/session-view', () => ({
  SessionView: ({ sessionId, onSessionCreated }: { sessionId: string | null; onSessionCreated: PendingMessagesContextValue['onSessionCreated'] }) => (
    <div data-testid="session-view" data-session={sessionId}>
      <button onClick={() => onSessionCreated('created-1', 'Hello', 'uuid')}>Send</button>
    </div>
  ),
}))

describe('SessionRoute view lifetime', () => {
  beforeEach(() => {
    mocks.sessionId = undefined
    mocks.agentSlug = 'agent-1'
    vi.clearAllMocks()
  })

  it('adopts its first session without remounting and replaces the draft URL', () => {
    const { rerender } = render(<SessionRoute />)
    const view = screen.getByTestId('session-view')
    fireEvent.click(screen.getByText('Send'))
    expect(mocks.created).toHaveBeenCalledWith('created-1', 'Hello', 'uuid', { replace: true })
    mocks.sessionId = 'created-1'
    rerender(<SessionRoute />)
    expect(screen.getByTestId('session-view')).toBe(view)
    expect(view).toHaveAttribute('data-session', 'created-1')

    // A later fresh draft must not retain the old handoff marker.
    mocks.sessionId = undefined
    rerender(<SessionRoute />)
    const fresh = screen.getByTestId('session-view')
    expect(fresh).not.toBe(view)
    mocks.sessionId = 'created-1'
    rerender(<SessionRoute />)
    expect(screen.getByTestId('session-view')).not.toBe(fresh)
  })

  it('resets the view when opening a different session or agent', () => {
    mocks.sessionId = 'session-1'
    const { rerender } = render(<SessionRoute />)
    const first = screen.getByTestId('session-view')
    mocks.sessionId = 'session-2'
    rerender(<SessionRoute />)
    const second = screen.getByTestId('session-view')
    expect(second).not.toBe(first)
    mocks.agentSlug = 'agent-2'
    rerender(<SessionRoute />)
    expect(screen.getByTestId('session-view')).not.toBe(second)
  })
})
