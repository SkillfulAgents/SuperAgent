// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HttpError } from '@renderer/lib/http-error'
import { isAnyVoiceModeActive, voiceModeTakesSpace } from '@renderer/lib/voice-mode-handoff'
import { VoiceModeHost, useVoiceModeHost } from './voice-mode-host'
import { VoiceModeOrb } from './voice-mode-orb'

const mocks = vi.hoisted(() => ({
  routeSessionId: undefined as string | undefined,
  navigate: vi.fn(),
  requests: [] as Array<{ key: string; kind: string }>,
  useVoiceMode: vi.fn(),
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  sessionError: null as Error | null,
  refetchSession: vi.fn(),
  providerError: null as object | null,
  canUseAgent: true,
}))
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ sessionId: mocks.routeSessionId }),
  useNavigate: () => mocks.navigate,
}))
vi.mock('@renderer/hooks/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/hooks/use-sessions')>()),
  useSession: () => ({ data: { name: 'Plan the launch' }, error: mocks.sessionError, refetch: mocks.refetchSession }),
}))
vi.mock('@renderer/components/provider-error/provider-error-placement', () => ({
  useShownProviderError: () => mocks.providerError,
}))
vi.mock('@shared/lib/tools/requests/use-pending-requests', () => ({
  usePendingRequests: () => ({ items: mocks.requests, count: mocks.requests.length }),
}))
vi.mock('@shared/lib/tools/registry', () => ({
  describeVoiceInputRequest: (item: { key: string }) => ({ id: item.key, message: 'Choose a database in the question card.' }),
}))
vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => ({ data: [] }),
  useSendMessage: () => ({ mutate: mocks.mutate, mutateAsync: mocks.mutateAsync }),
}))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ canUseAgent: () => mocks.canUseAgent }) }))
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

function StartVoiceInB() {
  const { start } = useVoiceModeHost()
  return <button data-testid="start-b" onClick={() => start({ sessionId: 'session-b', agentSlug: 'agent-1', openedByVoice: false })} />
}

function ComposerView() {
  const { registerView } = useVoiceModeHost()
  const frameRef = useRef<HTMLElement | null>(null)
  useEffect(() => registerView({ kind: 'composer', sessionId: 'session-a', suspended: false, inputRequests: [], frameRef }), [registerView])
  return null
}

function lastSend(): (text: string) => Promise<boolean> {
  return mocks.useVoiceMode.mock.lastCall![0].send
}

function renderOrb(extra?: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return render(
    <VoiceModeHost>
      <StartVoice />
      <VoiceModeOrb />
      {extra}
    </VoiceModeHost>,
    { wrapper },
  )
}

describe('VoiceModeOrb', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.routeSessionId = undefined
    mocks.requests = []
    mocks.sessionError = null
    mocks.providerError = null
    mocks.canUseAgent = true
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value) },
    })
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
    fireEvent.pointerDown(open, { clientX: 10, clientY: 10, pointerId: 1, button: 0 })
    fireEvent.pointerUp(open, { clientX: 10, clientY: 10, pointerId: 1, button: 0 })
    fireEvent.click(open)
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

  it('ends voice mode once its session is gone, whoever deleted it or its agent', () => {
    mocks.routeSessionId = 'session-b'
    const { rerender } = renderOrb()
    expect(screen.getByTestId('voice-mode-orb')).toBeInTheDocument()

    mocks.sessionError = new HttpError(404)
    rerender(<VoiceModeHost><StartVoice /><VoiceModeOrb /></VoiceModeHost>)
    expect(screen.queryByTestId('voice-mode-orb')).toBeNull()
    expect(mocks.useVoiceMode).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }))
  })

  it('checks the session again when an utterance fails to send', async () => {
    mocks.routeSessionId = 'session-b'
    mocks.mutateAsync.mockRejectedValueOnce(new HttpError(404))
    renderOrb()
    await expect(lastSend()('Is the launch still on?')).resolves.toBe(false)
    expect(mocks.refetchSession).toHaveBeenCalledOnce()
  })

  it('starts the next session\'s conversation without the orb view of the last one', () => {
    mocks.routeSessionId = 'session-b'
    mocks.requests = [{ key: 'question-1', kind: 'question' }]
    renderOrb(<StartVoiceInB />)
    expect(mocks.useVoiceMode).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-a', paused: true }))

    fireEvent.click(screen.getByTestId('start-b'))
    const callsForB = mocks.useVoiceMode.mock.calls.map(([args]) => args).filter((args) => args.sessionId === 'session-b')
    expect(callsForB.length).toBeGreaterThan(0)
    for (const args of callsForB) expect(args).toMatchObject({ paused: false, inputRequests: [] })
  })

  it('is not in voice mode for an agent the person cannot use', () => {
    mocks.routeSessionId = 'session-b'
    mocks.canUseAgent = false
    renderOrb()
    expect(screen.queryByTestId('voice-mode-orb')).toBeNull()
    expect(isAnyVoiceModeActive()).toBe(false)
  })

  it('pauses the conversation while a provider error waits at the composer', () => {
    mocks.routeSessionId = 'session-b'
    mocks.providerError = { current: {}, resolved: {} }
    renderOrb()
    expect(screen.getByTestId('voice-mode-orb-notice')).toHaveTextContent('Needs your input')
    expect(mocks.useVoiceMode).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, paused: true }))
  })

  it('opens from the keyboard', () => {
    mocks.routeSessionId = 'session-b'
    renderOrb()
    // Enter or Space on a focused button fires a click with no pointer events.
    fireEvent.click(screen.getByTestId('voice-mode-orb-open'))
    expect(mocks.navigate).toHaveBeenCalledOnce()
  })

  it('moves on a quick flick to where the pointer let go, without opening', () => {
    mocks.routeSessionId = 'session-b'
    renderOrb()
    const open = screen.getByTestId('voice-mode-orb-open')
    fireEvent.pointerDown(open, { clientX: 10, clientY: 10, pointerId: 1, button: 0 })
    fireEvent.pointerMove(open, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(open, { clientX: 200, clientY: 300, pointerId: 1, button: 0 })
    fireEvent.click(open)
    expect(mocks.navigate).not.toHaveBeenCalled()
    // jsdom lays the orb out at 0,0 in a 1024x768 window.
    expect(JSON.parse(localStorage.getItem('voice-mode-orb-position')!)).toEqual({ side: 'left', bottom: 768 - 290 - 48 })
  })

  it('does not open on a right-click', () => {
    mocks.routeSessionId = 'session-b'
    renderOrb()
    const open = screen.getByTestId('voice-mode-orb-open')
    fireEvent.pointerDown(open, { clientX: 10, clientY: 10, pointerId: 1, button: 2 })
    fireEvent.pointerUp(open, { clientX: 10, clientY: 10, pointerId: 1, button: 2 })
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('puts the orb back when the browser cancels a drag', () => {
    mocks.routeSessionId = 'session-b'
    renderOrb()
    const open = screen.getByTestId('voice-mode-orb-open')
    fireEvent.pointerDown(open, { clientX: 10, clientY: 10, pointerId: 1, button: 0 })
    fireEvent.pointerMove(open, { clientX: 100, clientY: 100, pointerId: 1 })
    expect(screen.queryByTestId('voice-mode-orb-exit')).toBeNull()
    fireEvent.pointerCancel(open, { pointerId: 1 })
    expect(screen.getByTestId('voice-mode-orb-exit')).toBeInTheDocument()
    expect(screen.getByTestId('voice-mode-orb')).toHaveStyle({ right: '16px', bottom: '120px' })
  })

  it('takes Space on the page only while the composer shows the conversation', () => {
    mocks.routeSessionId = 'session-b'
    const { unmount } = renderOrb()
    expect(screen.getByTestId('voice-mode-orb')).toBeInTheDocument()
    expect(voiceModeTakesSpace()).toBe(false)
    unmount()

    mocks.routeSessionId = 'session-a'
    renderOrb(<ComposerView />)
    expect(voiceModeTakesSpace()).toBe(true)
  })
})
