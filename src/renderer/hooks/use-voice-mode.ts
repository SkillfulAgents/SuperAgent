import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { readAloud, voiceStreamId } from './use-read-aloud'
import { useMessageStream } from './use-message-stream'
import { useInterruptSession } from './use-messages'
import { VoiceListener } from '@renderer/lib/voice-listener'

/**
 * listening: the mic is the person's; what they say is sent when they pause.
 * thinking:  their message is with the agent; nothing to hear yet.
 * speaking:  the reply is being read aloud as it streams in.
 * The mic stays open in every phase: talking over the agent interrupts it.
 */
export type VoiceModePhase = 'listening' | 'thinking' | 'speaking'

/** Words the person must say over the agent, in one breath, before it is interrupted. */
export const INTERRUPT_WORD_THRESHOLD = 4
/**
 * Ducked on voice activity alone (a cough has no words, so no silence
 * signal follows it either), the reply comes back up after this long.
 * Real talking crosses the interrupt threshold well within it.
 */
export const DUCK_MAX_MS = 4_000
/** After a send, the agent counts as busy until the stream says so, at most this long. */
const TURN_START_GRACE_MS = 8_000
/** A send made right after an interrupt waits for the server to acknowledge it, at most this long. */
const INTERRUPT_WAIT_MS = 5_000
/** A mic that died is reopened after this long, doubling each time it dies again, up to the cap. */
export const LISTENER_RESTART_MS = 1_000
const LISTENER_RESTART_MAX_MS = 15_000
/**
 * Words heard this close to the end of the agent's turn are the person
 * starting to answer, and are kept; anything older was noise while the
 * agent spoke, and is dropped.
 */
const KEEP_RECENT_WORDS_MS = 2_500

interface UseVoiceModeArgs {
  sessionId: string
  agentSlug: string
  /** Voice mode is on. Turning it off releases the mic and silences the reader. */
  active: boolean
  /** Send one utterance as a message. Resolves false when nothing was sent. */
  send: (text: string) => Promise<boolean>
  /**
   * The agent already has the floor when voice mode starts (a session opened
   * by voice: its first message is the notice, and the reply is on its way),
   * so the reply is read rather than waited out.
   */
  startWithAgentTurn?: boolean
}

/**
 * The voice-to-voice loop for one session: a continuously open mic whose
 * utterances are sent on silence, and a reader that speaks each reply as it
 * streams in. Talking over the agent (or pressing the mic) interrupts it.
 */
export function useVoiceMode({ sessionId, agentSlug, active, send, startWithAgentTurn = false }: UseVoiceModeArgs) {
  const { isActive, streamingMessage, streamingToolUses } = useMessageStream(active ? sessionId : null, active ? agentSlug : null)
  const toolsRunning = (streamingToolUses?.length ?? 0) > 0
  const interruptSession = useInterruptSession()
  const streamId = voiceStreamId(sessionId)

  const readerSnapshot = useSyncExternalStore(readAloud.subscribe, readAloud.getSnapshot, readAloud.getSnapshot)
  const readerActive = readerSnapshot.activeId === streamId
  const readerSpeaking = readerActive && readerSnapshot.status === 'speaking'
  const readerError = readerSnapshot.errorId === streamId ? readerSnapshot.error : null

  const [utterance, setUtterance] = useState('')
  // The person's turn: listening. Otherwise the agent's: thinking or speaking.
  const [userTurn, setUserTurn] = useState(!startWithAgentTurn)
  // A message was just sent and the stream has not yet reported the turn.
  const [awaitingTurn, setAwaitingTurn] = useState(startWithAgentTurn)
  const [error, setError] = useState<string | null>(null)
  // The agent's turn has reached a tool call. Until then it is either about
  // to speak or thinking; after, it is working, which sounds different.
  const [toolCalled, setToolCalled] = useState(false)

  const listenerRef = useRef<VoiceListener | null>(null)
  // Bumped to reopen the mic after it died.
  const [listenerEpoch, setListenerEpoch] = useState(0)
  const listenerRestartsRef = useRef(0)
  const interruptRef = useRef<() => void>(() => {})
  const userTurnRef = useRef(userTurn)
  userTurnRef.current = userTurn
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  // A send is confirmed by the stream reporting a turn that began after it.
  // An active flag still true from the turn just interrupted is not that,
  // so the flag must first be seen false ("armed") and then true again.
  const turnStartArmedRef = useRef(true)
  // The interrupt sent just before an utterance, for the send to wait on.
  const interruptPendingRef = useRef<Promise<void> | null>(null)
  const sendRef = useRef(send)
  sendRef.current = send
  const sendingRef = useRef(false)
  // The reply text last handed to the reader, to tell a growing message from
  // a new one; and the previous turn's text, so it is never read again after
  // the next send.
  const fedRef = useRef('')
  const staleTextRef = useRef<string | null>(null)
  const readerStartedRef = useRef(false)
  const streamingRef = useRef(streamingMessage)
  streamingRef.current = streamingMessage
  const lastHeardAtRef = useRef(0)
  const duckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Where the current breath began in the utterance, so scattered noise
  // over a long turn ("mm hmm" ... "ok" ... "right") never adds up to an
  // interruption.
  const burstStartRef = useRef(0)

  const interrupt = useCallback(() => {
    readAloud.stop()
    readerStartedRef.current = false
    if (duckTimerRef.current) {
      clearTimeout(duckTimerRef.current)
      duckTimerRef.current = null
    }
    // A message just sent is a turn to stop even before the stream has
    // reported it active; the server treats an interrupt of an idle session
    // as nothing to do.
    if (isActive || awaitingTurn) {
      interruptPendingRef.current = new Promise<void>((resolve) => {
        interruptSession.mutate({ sessionId, agentSlug }, { onSettled: () => resolve() })
      })
    }
    setUserTurn(true)
    setAwaitingTurn(false)
  }, [isActive, awaitingTurn, interruptSession, sessionId, agentSlug])

  const sendUtterance = useCallback(async () => {
    const listener = listenerRef.current
    if (!listener || sendingRef.current) return
    sendingRef.current = true
    try {
      const text = await listener.take()
      if (!text) return
      staleTextRef.current = streamingRef.current ?? ''
      turnStartArmedRef.current = !isActiveRef.current
      setUserTurn(false)
      setAwaitingTurn(true)
      setError(null)
      // Interrupted just before: the server must have ended that turn first,
      // or it queues this message into it and the interrupt discards it.
      const pendingInterrupt = interruptPendingRef.current
      if (pendingInterrupt) {
        await Promise.race([pendingInterrupt, new Promise<void>((r) => setTimeout(r, INTERRUPT_WAIT_MS))])
        if (interruptPendingRef.current === pendingInterrupt) interruptPendingRef.current = null
      }
      let sent = false
      try {
        sent = await sendRef.current(text)
        // The composer declined (offline, uploads in flight): the words are
        // gone from the mic, so say so rather than sitting silent.
        if (!sent) setError('Could not send that. Please say it again.')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send message')
      }
      if (!sent) {
        setUserTurn(true)
        setAwaitingTurn(false)
      }
    } finally {
      sendingRef.current = false
    }
  }, [])

  // The mic itself: send now while listening, interrupt while the agent has the floor.
  const pressMic = useCallback(() => {
    if (userTurnRef.current) void sendUtterance()
    else interrupt()
  }, [sendUtterance, interrupt])

  // Open the mic for as long as voice mode is on. A mic that dies (its
  // socket gone for good) is reopened after a pause, longer each time.
  useEffect(() => {
    if (!active) return
    let restartTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRestart = () => {
      if (restartTimer) return
      const delay = Math.min(LISTENER_RESTART_MAX_MS, LISTENER_RESTART_MS * 2 ** listenerRestartsRef.current)
      listenerRestartsRef.current++
      restartTimer = setTimeout(() => setListenerEpoch((n) => n + 1), delay)
    }
    const unduck = () => {
      if (duckTimerRef.current) {
        clearTimeout(duckTimerRef.current)
        duckTimerRef.current = null
      }
      readAloud.duckStream(streamId, false)
    }
    const listener = new VoiceListener({
      onUtterance: (text) => {
        setUtterance(text)
        if (text.trim()) lastHeardAtRef.current = Date.now()
        // Talking over the agent, past a few words in one breath, is an
        // interruption. (The utterance may have been taken since the breath
        // began, so its start is clamped to what is there.)
        const words = listener.wordCount
        const inBreath = words - Math.min(burstStartRef.current, words)
        if (!userTurnRef.current && inBreath >= INTERRUPT_WORD_THRESHOLD) interruptRef.current()
      },
      onSpeechStarted: () => {
        burstStartRef.current = listener.wordCount
        if (userTurnRef.current) return
        // The person is talking over the reply: turn it down at once, so
        // echo cancellation is not fighting the speaker for their first words.
        readAloud.duckStream(streamId, true)
        if (duckTimerRef.current) clearTimeout(duckTimerRef.current)
        duckTimerRef.current = setTimeout(unduck, DUCK_MAX_MS)
      },
      onSpeechEnded: () => {
        if (userTurnRef.current) {
          if (listener.utterance.trim()) void sendUtterance()
          return
        }
        // Stopped short of an interruption: the reply comes back up.
        unduck()
      },
      onError: (err) => {
        setError(err.message)
        scheduleRestart()
      },
    })
    listenerRef.current = listener
    setError(null)
    listener.start().then(
      () => {
        if (listenerRef.current !== listener) return
        // Up, so whatever killed the last one is over.
        listenerRestartsRef.current = 0
        setError(null)
      },
      (err: unknown) => {
        if (listenerRef.current !== listener) return
        setError(err instanceof Error ? err.message : 'Failed to start listening')
        scheduleRestart()
      },
    )
    return () => {
      if (restartTimer) clearTimeout(restartTimer)
      if (duckTimerRef.current) {
        clearTimeout(duckTimerRef.current)
        duckTimerRef.current = null
      }
      listener.stop()
      if (listenerRef.current === listener) listenerRef.current = null
      readAloud.stop()
      readerStartedRef.current = false
      fedRef.current = ''
    }
  }, [active, sessionId, sendUtterance, streamId, listenerEpoch])
  interruptRef.current = interrupt

  useEffect(() => {
    if (userTurn) setToolCalled(false)
    else if (toolsRunning) setToolCalled(true)
  }, [userTurn, toolsRunning])

  // Voice mode off: the floor is nobody's. (Not in the cleanup above — a
  // development-mode remount re-runs that with the mode still on, and would
  // hand the floor to the person while the agent is mid-reply.)
  useEffect(() => {
    if (active) return
    setUtterance('')
    setUserTurn(true)
    setAwaitingTurn(false)
    listenerRestartsRef.current = 0
    interruptPendingRef.current = null
  }, [active])

  // The stream confirms the turn started: it reports active after having
  // been idle since the send (an interrupted turn still winding down does
  // not count).
  useEffect(() => {
    if (!awaitingTurn) return
    if (!isActive) {
      turnStartArmedRef.current = true
      return
    }
    if (turnStartArmedRef.current) setAwaitingTurn(false)
  }, [awaitingTurn, isActive])

  // Or never will: give up waiting.
  useEffect(() => {
    if (!awaitingTurn) return
    const timer = setTimeout(() => setAwaitingTurn(false), TURN_START_GRACE_MS)
    return () => clearTimeout(timer)
  }, [awaitingTurn])

  // Feed the reply to the reader as it streams in. Tool calls are not text
  // and never reach here; each assistant message of the turn is a segment.
  useEffect(() => {
    if (!active || userTurn) return
    const text = streamingMessage ?? ''
    if (text && text === staleTextRef.current) return
    staleTextRef.current = null
    // Reply text is proof the turn started, however the active flag lags.
    if (text) setAwaitingTurn(false)
    if (!text) {
      if (fedRef.current && readerStartedRef.current) readAloud.nextStreamSegment(streamId)
      fedRef.current = ''
      return
    }
    if (!readerStartedRef.current) {
      readAloud.beginStream(streamId)
      readerStartedRef.current = true
      fedRef.current = ''
    } else if (fedRef.current && !text.startsWith(fedRef.current)) {
      readAloud.nextStreamSegment(streamId)
    }
    fedRef.current = text
    readAloud.pushStream(streamId, text)
  }, [active, userTurn, streamingMessage, streamId])

  // The turn ended: let the reader finish what it has.
  useEffect(() => {
    if (!active || userTurn || awaitingTurn || isActive) return
    if (readerStartedRef.current) {
      readAloud.endStream(streamId)
      readerStartedRef.current = false
    }
  }, [active, userTurn, awaitingTurn, isActive, streamId])

  // The reply has been spoken (or there was nothing to speak): the person's
  // turn. Words heard just now are the person starting to answer over the
  // tail of the reply, and are kept; anything older was noise while the
  // agent spoke.
  useEffect(() => {
    if (!active || userTurn || awaitingTurn || isActive || readerActive) return
    setUserTurn(true)
    const listener = listenerRef.current
    if (listener?.utterance.trim() && Date.now() - lastHeardAtRef.current > KEEP_RECENT_WORDS_MS) void listener.discard()
  }, [active, userTurn, awaitingTurn, isActive, readerActive])

  const phase: VoiceModePhase = userTurn ? 'listening' : readerSpeaking ? 'speaking' : 'thinking'
  const getAnalyser = useCallback(() => listenerRef.current?.analyser ?? null, [])
  const clearError = useCallback(() => setError(null), [])

  return {
    phase,
    /** The agent has the floor and its turn has reached a tool call: it is working, not about to answer. */
    working: !userTurn && toolCalled,
    /** What the person has said so far in this utterance. */
    utterance,
    error: error ?? readerError,
    clearError,
    pressMic,
    getAnalyser,
  }
}
