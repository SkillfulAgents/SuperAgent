// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { VoiceModeHost, useVoiceModeHost } from './voice-mode-host'
import { VoiceModeOrb } from './voice-mode-orb'

const mocks = vi.hoisted(() => ({
  routeSessionId: undefined as string | undefined,
  navigate: vi.fn(),
  requests: [] as Array<{ key: string; kind: string }>,
  useVoiceMode: vi.fn(),
  mutate: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ sessionId: mocks.routeSessionId }),
  useNavigate: () => mocks.navigate,
}))
vi.mock('@renderer/hooks/use-sessions', () => ({ useSession: () => ({ data: { name: 'Plan the launch' } }) }))
vi.mock('@shared/lib/tools/requests/use-pending-requests', () => ({
  usePendingRequests: () => ({ items: mocks.requests, count: mocks.requests.length }),
}))
vi.mock('@shared/lib/tools/registry', () => ({
  describeVoiceInputRequest: (item: { key: string }) => ({ id: item.key, message: 'Choose a database in the question card.' }),
}))
vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => ({ data: [] }),
  useSendMessage: () => ({ mutate: mocks.mutate, mutateAsync: vi.fn() }),
}))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ canUseAgent: () => true }) }))
vi.mock('@renderer/hooks/use-hold-sound', () => ({ useHoldSound: () => {} }))
vi.mock('@renderer/hooks/use-user-music', () => ({
  useUserMusicPreference: () => false,
  useUserMusicSession: () => ({ active: false, playerName: null }),
  userMusicSupported: () => false,
}))
vi.mock('./voice-mode-controls', () => ({
  useHoldSoundPreference: () => false,
  VoiceToggleButton: ({ onClick, testId, label }: { onClick: () => void; testId: string; label: string }) => (
    <button onClick={onClick} data-testid={testId} aria-label={label} />
  ),
}))
vi.mock('./voice-orb', () => ({ VoiceOrb: () => null }))
vi.mock('@renderer/hooks/use-voice-mode', () => ({
  useVoiceMode: (args: unknown) => {
    mocks.useVoiceMode(args)
    return {
      phase: 'thinking', ready: true, userSpeaking: false, working: true, error: null,
      hold: { allowed: false, delayMs: 700 }, micMuted: false, outputMuted: false,
      setMicMuted: vi.fn(), setOutputMuted: vi.fn(), pressMic: vi.fn(),
      getAnalyser: () => null, getOutputAnalyser: () => null,
    }
  },
}))

function StartVoice() {
  const { start } = useVoiceModeHost()
  useEffect(() => start({ sessionId: 'session-a', agentSlug: 'agent-1', openedByVoice: true }), [start])
  return null
}

function renderOrb() {
  return render(
    <VoiceModeHost>
      <StartVoice />
      <VoiceModeOrb />
    </VoiceModeHost>,
  )
}

describe('VoiceModeOrb', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.routeSessionId = undefined
    mocks.requests = []
    // jsdom has no pointer capture.
    Element.prototype.setPointerCapture = vi.fn()
  })

  it('shows only away from the voice session, and opens it on click', () => {
    mocks.routeSessionId = 'session-a'
    const { rerender } = renderOrb()
    expect(screen.queryByTestId('voice-mode-orb')).toBeNull()

    mocks.routeSessionId = 'session-b'
    rerender(<VoiceModeHost><StartVoice /><VoiceModeOrb /></VoiceModeHost>)
    const open = screen.getByTestId('voice-mode-orb-open')
    fireEvent.pointerDown(open, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(open, { clientX: 10, clientY: 10, pointerId: 1 })
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'agent-1', sessionId: 'session-a' },
    })
  })

  it('pauses the conversation and says so while a request card waits', () => {
    mocks.routeSessionId = 'session-b'
    mocks.requests = [{ key: 'question-1', kind: 'question' }]
    renderOrb()
    expect(screen.getByTestId('voice-mode-orb-notice')).toHaveTextContent('Needs your input')
    expect(mocks.useVoiceMode).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-a',
      active: true,
      paused: true,
      inputRequests: [{ id: 'question-1', message: 'Choose a database in the question card.' }],
    }))
  })

  it('ends the conversation from its exit control, with the exit notice', async () => {
    vi.useFakeTimers()
    try {
      mocks.routeSessionId = 'session-b'
      renderOrb()
      fireEvent.click(screen.getByTestId('voice-mode-orb-exit'))
      expect(screen.queryByTestId('voice-mode-orb')).toBeNull()
      act(() => { vi.runAllTimers() })
      expect(mocks.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-a', shouldQuery: false }), expect.anything(),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
