import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useMessages, useSendMessage } from '@renderer/hooks/use-messages'
import { useVoiceMode, type VoiceModeResult } from '@renderer/hooks/use-voice-mode'
import { useHoldSound } from '@renderer/hooks/use-hold-sound'
import { useUserMusicPreference, useUserMusicSession, userMusicSupported } from '@renderer/hooks/use-user-music'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useUser } from '@renderer/context/user-context'
import { holdSound } from '@renderer/lib/voice/shared/speech/hold-sound'
import { userMusic } from '@renderer/lib/voice/shared/speech/user-music'
import { registerVoiceModeExit, setVoiceModeActive } from '@renderer/lib/voice-mode-handoff'
import { VOICE_MODE_ENTERED_MESSAGE, VOICE_MODE_EXITED_MESSAGE } from '@shared/lib/voice/voice-mode-messages'
import { boundVoiceHistoryTransport } from '@shared/lib/voice/voice-history-transport'
import type { VoiceInputRequest } from '@renderer/lib/voice/contracts/conversation'
import { useHoldSoundPreference } from './voice-mode-controls'

export interface VoiceSession {
  sessionId: string
  agentSlug: string
  /** Started from the agent home's voice button; its first message already is the entry notice. */
  openedByVoice: boolean
}

/**
 * What is on screen for the voice session: its composer while the session is
 * open, the floating orb anywhere else. It tells the conversation whether a
 * request card holds it, and the composer also sends what is said, so the
 * message gets its optimistic copy and the composer's model options.
 */
export interface VoiceModeView {
  kind: 'composer' | 'orb'
  suspended: boolean
  inputRequests: readonly VoiceInputRequest[]
  frameRef: RefObject<HTMLElement | null>
  submitRef?: RefObject<((text: string) => Promise<boolean>) | undefined>
}

interface VoiceModeHostValue {
  session: VoiceSession | null
  voice: VoiceModeResult
  /** One voice conversation at a time: starting one ends the other, with its exit notice. */
  start(session: VoiceSession): void
  exit(): void
  registerView(view: VoiceModeView): () => void
}

const VoiceModeHostContext = createContext<VoiceModeHostValue | null>(null)

export function useVoiceModeHost(): VoiceModeHostValue {
  const value = useContext(VoiceModeHostContext)
  if (!value) throw new Error('useVoiceModeHost must be used within a VoiceModeHost')
  return value
}

/**
 * Whether Space is voice mode's to take: nothing else has handled it, and
 * focus is on the page itself (only while the session's composer is on
 * screen) or on the voice frame outside its controls. Anywhere else (the
 * message list, a drawer row, the live browser) Space keeps its own meaning.
 */
function spaceInterruptsVoice(event: KeyboardEvent, view: VoiceModeView | null): boolean {
  if (event.defaultPrevented || !view) return false
  const target = event.target
  if (target === document.body) return view.kind === 'composer'
  const frame = view.frameRef.current
  if (!(target instanceof Element) || !frame?.contains(target)) return false
  return target.closest('button, input, textarea, select, a[href], [role="button"]') === null
}

const NO_INPUT_REQUESTS: readonly VoiceInputRequest[] = []

/**
 * Owns the voice conversation above the routes, so it carries on while the
 * person looks at another session, another agent, or settings.
 */
export function VoiceModeHost({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<VoiceSession | null>(null)
  const [view, setView] = useState<VoiceModeView | null>(null)
  const sessionId = session?.sessionId ?? null
  const agentSlug = session?.agentSlug ?? ''
  const { track } = useAnalyticsTracking()
  const trackRef = useRef(track)
  trackRef.current = track
  const { canUseAgent } = useUser()
  const active = !!session && canUseAgent(session.agentSlug)

  // Its own mutation: a pending send must not hold up an utterance. A notice
  // that fails (the session was deleted, the app is offline as the person
  // leaves) is not worth a toast: the agent misses a hint.
  const sendNotice = useSendMessage({ quiet: true })
  const sendNoticeRef = useRef(sendNotice)
  sendNoticeRef.current = sendNotice
  const notify = useCallback((target: VoiceSession, content: string) => {
    sendNoticeRef.current.mutate(
      { sessionId: target.sessionId, agentSlug: target.agentSlug, content, shouldQuery: false },
      { onError: (err) => console.warn('Voice-mode notice not delivered:', err) },
    )
  }, [])
  const sendMessage = useSendMessage({ agentRuntimeErrorsShownInline: true })

  const start = useCallback((next: VoiceSession) => {
    if (!next.openedByVoice) notify(next, VOICE_MODE_ENTERED_MESSAGE)
    setSession((previous) => previous?.sessionId === next.sessionId ? previous : next)
  }, [notify])
  const exit = useCallback(() => setSession(null), [])
  const registerView = useCallback((next: VoiceModeView) => {
    setView(next)
    return () => setView((current) => current === next ? null : current)
  }, [])

  // Ending tells the agent, whether by the exit button, another session's
  // voice mode, or the window closing. Deferred a tick so a development-mode
  // remount does not send it for a conversation that is still on.
  const exitTimerRef = useRef<{ sessionId: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  useEffect(() => {
    if (!session) return
    if (exitTimerRef.current?.sessionId === session.sessionId) {
      clearTimeout(exitTimerRef.current.timer)
      exitTimerRef.current = null
    }
    setVoiceModeActive(session.sessionId, true)
    const unregisterExit = registerVoiceModeExit(session.sessionId, exit)
    return () => {
      unregisterExit()
      setVoiceModeActive(session.sessionId, false)
      const timer = setTimeout(() => {
        notify(session, VOICE_MODE_EXITED_MESSAGE)
        trackRef.current('voice_mode_exited', { origin: session.openedByVoice ? 'home' : 'session' })
      }, 0)
      exitTimerRef.current = { sessionId: session.sessionId, timer }
    }
  }, [session, exit, notify])

  const { data: messages } = useMessages(sessionId, agentSlug)
  // Transport bound only; the host trims to the voice model's token budget.
  const history = useMemo(() => boundVoiceHistoryTransport((messages ?? []).flatMap((message) =>
    (message.type === 'user' || message.type === 'assistant') && message.content.text.trim()
      ? [{ role: message.type, content: message.content.text }]
      : [],
  )), [messages])

  const suspended = view?.suspended ?? false
  const voice = useVoiceMode({
    sessionId,
    agentSlug,
    active,
    paused: suspended,
    inputRequests: view?.inputRequests ?? NO_INPUT_REQUESTS,
    send: async (text) => {
      const submit = view?.submitRef?.current
      if (submit) return submit(text)
      if (!sessionId) return false
      try {
        await sendMessage.mutateAsync({ sessionId, agentSlug, content: text })
      } catch {
        return false
      }
      track('message_sent', { origin: 'user', input_mode: 'voice' })
      return true
    },
    startWithAgentTurn: session?.openedByVoice ?? false,
    history,
  })

  // Keys while voice mode is on: Space interrupts the agent (the orb's own
  // action while it has the floor), ⌘⇧M (Ctrl⇧M) mutes the microphone and
  // ⌘⇧A (Ctrl⇧A) the agent's voice. Read from the latest render so the
  // listener is bound once per voice session.
  const latest = useRef({ voice, view })
  latest.current = { voice, view }
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      const { voice: current, view: currentView } = latest.current
      if (event.key === ' ' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (!spaceInterruptsVoice(event, currentView)) return
        if (current.phase === 'listening') return
        current.pressMic()
        event.preventDefault()
        return
      }
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'm') current.setMicMuted(!current.micMuted)
      else if (key === 'a') current.setOutputMuted(!current.outputMuted)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active])

  // Something to hear while the agent works, unless the person muted it:
  // their own music if it was playing when voice mode came on, else the loop.
  // The takeover lasts the whole voice session: a muted hold sound or a
  // request card keeps the music paused, and leaving voice mode gives it back.
  const holdSoundWanted = useHoldSoundPreference()
  const userMusicWanted = useUserMusicPreference()
  const music = useUserMusicSession(active && userMusicWanted && userMusicSupported())
  useHoldSound({
    enabled: active && !suspended && holdSoundWanted,
    agentTurn: voice.hold.allowed,
    delayMs: voice.hold.delayMs,
    speaking: voice.speechActive ?? voice.phase === 'speaking',
    working: voice.working,
    source: music.active ? userMusic : holdSound,
  })

  const value = useMemo<VoiceModeHostValue>(
    () => ({ session: active ? session : null, voice, start, exit, registerView }),
    [active, session, voice, start, exit, registerView],
  )
  return <VoiceModeHostContext.Provider value={value}>{children}</VoiceModeHostContext.Provider>
}
