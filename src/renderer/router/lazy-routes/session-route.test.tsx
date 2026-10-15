// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionRoute } from './session-route'
import { exitOtherVoiceModes, registerVoiceModeExit, setVoiceModeActive } from '@renderer/lib/voice-mode-handoff'
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
  SessionView: ({ sessionId, onSessionCreated, background }: { sessionId: string | null; onSessionCreated: PendingMessagesContextValue['onSessionCreated']; background: boolean }) => (
    <div data-testid={background ? 'hidden-session-view' : 'session-view'} data-session={sessionId}>
      <button onClick={() => onSessionCreated('created-1', 'Hello', 'uuid')}>Send</button>
    </div>
  ),
}))

describe('SessionRoute view lifetime', () => {
  beforeEach(() => {
    setVoiceModeActive('session-1', false)
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

  it('keeps a session in voice mode mounted out of sight until voice mode ends', () => {
    mocks.sessionId = 'session-1'
    const { rerender } = render(<SessionRoute />)
    const voiceView = screen.getByTestId('session-view')
    act(() => setVoiceModeActive('session-1', true))

    mocks.sessionId = 'session-2'
    rerender(<SessionRoute />)
    expect(screen.getByTestId('hidden-session-view')).toBe(voiceView)
    expect(screen.getByTestId('session-view')).toHaveAttribute('data-session', 'session-2')

    // Going back shows the same view again, and the other one goes.
    mocks.sessionId = 'session-1'
    rerender(<SessionRoute />)
    expect(screen.getByTestId('session-view')).toBe(voiceView)
    expect(screen.queryByTestId('hidden-session-view')).toBeNull()

    mocks.sessionId = 'session-2'
    rerender(<SessionRoute />)
    expect(screen.getByTestId('hidden-session-view')).toBe(voiceView)
    act(() => setVoiceModeActive('session-1', false))
    expect(screen.queryByTestId('hidden-session-view')).toBeNull()
    expect(screen.getByTestId('session-view')).toHaveAttribute('data-session', 'session-2')
  })

  it('drops the hidden voice session when another agent opens', () => {
    mocks.sessionId = 'session-1'
    const { rerender } = render(<SessionRoute />)
    act(() => setVoiceModeActive('session-1', true))
    mocks.sessionId = 'session-2'
    rerender(<SessionRoute />)
    expect(screen.getByTestId('hidden-session-view')).toBeInTheDocument()
    mocks.agentSlug = 'agent-2'
    rerender(<SessionRoute />)
    expect(screen.queryByTestId('hidden-session-view')).toBeNull()
  })
})

describe('exitOtherVoiceModes', () => {
  it('ends voice mode in every session but the one starting it', () => {
    const exitFirst = vi.fn()
    const exitSecond = vi.fn()
    const unregister = [registerVoiceModeExit('session-1', exitFirst), registerVoiceModeExit('session-2', exitSecond)]
    setVoiceModeActive('session-1', true)
    setVoiceModeActive('session-2', true)
    exitOtherVoiceModes('session-2')
    expect(exitFirst).toHaveBeenCalledTimes(1)
    expect(exitSecond).not.toHaveBeenCalled()
    setVoiceModeActive('session-2', false)
    unregister.forEach((fn) => fn())
  })
})
