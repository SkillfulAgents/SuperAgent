import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { acquireMicStream, createSttAdapter, startAudioCapture, type SttAdapter, type VoiceProvider, type AudioCaptureHandle, type CaptureKind } from '@renderer/lib/stt'
import { addRendererBreadcrumb, captureRendererException, captureRendererMessage } from '@renderer/lib/error-reporting'
import type { TtsVoiceInfo } from '@shared/lib/voice/tts-preferences'

// 'finalizing': mic released, but we're flushing buffered audio and awaiting the
// server's trailing transcripts before the final text is ready.
export type VoiceInputState = 'idle' | 'connecting' | 'recording' | 'finalizing'

/**
 * One dictation attempt, from credentials to final text, as the error reports
 * describe it. Dictation audio goes from the browser straight to the speech
 * provider, so nothing server-side sees a session that fails on that leg; the
 * renderer has to report it.
 */
interface DictationSession {
  provider: VoiceProvider
  /** Ordinal of this attempt within the page, so retries can be told apart. */
  attempt: number
  startedAt: number
  adapter: SttAdapter
  captureKind?: CaptureKind
  contextSampleRate?: number
  track?: Record<string, unknown>
  /** An error has already been shown and reported for this session. */
  failed: boolean
}

/**
 * Audio a session must have captured before ending with no words counts as a
 * failure worth reporting, rather than a mic tap the person changed their mind
 * about. In seconds of PCM at the adapter's rate.
 */
const NO_TRANSCRIPT_REPORT_MIN_SECONDS = 1.5

/**
 * A peak sample at or below this (about -36 dBFS) means the mic delivered
 * silence: the person did not speak, or the OS handed us a muted device.
 */
const SILENT_PEAK_SAMPLE = 500

/** Denied or missing mic permission is the person's choice, not a defect. */
function isMicPermissionRefusal(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError')
}

function describeTrack(stream: MediaStream): Record<string, unknown> {
  const track = stream.getAudioTracks()[0]
  if (!track) return { present: false }
  const settings = typeof track.getSettings === 'function' ? track.getSettings() : {}
  return {
    present: true,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    sampleRate: settings.sampleRate,
    channelCount: settings.channelCount,
  }
}

function describeSession(session: DictationSession): Record<string, unknown> {
  return {
    provider: session.provider,
    attempt: session.attempt,
    durationMs: Date.now() - session.startedAt,
    captureKind: session.captureKind,
    contextSampleRate: session.contextSampleRate,
    adapterSampleRate: session.adapter.sampleRate ?? 16000,
    track: session.track,
    ...session.adapter.stats,
  }
}

function reportSessionFailure(session: DictationSession | null, provider: VoiceProvider | undefined, stage: string, err: unknown): void {
  if (session) session.failed = true
  if (isMicPermissionRefusal(err)) {
    addRendererBreadcrumb('dictation', 'microphone permission refused', { stage })
    return
  }
  captureRendererException(err, {
    tags: { feature: 'dictation', stage, provider: session?.provider ?? provider ?? 'unknown' },
    extra: session ? describeSession(session) : undefined,
  })
}

/**
 * The session ended with audio captured but no words back, and no error was
 * shown: the case that otherwise leaves no trace anywhere. Tagged so a socket
 * that never opened, silence from the mic, and a server that stayed quiet can
 * each be told apart in the tracker.
 */
function reportNoTranscript(session: DictationSession): void {
  const stats = session.adapter.stats
  if (!stats) return
  const minBytes = (session.adapter.sampleRate ?? 16000) * 2 * NO_TRANSCRIPT_REPORT_MIN_SECONDS
  if (stats.bytesReceived < minBytes) return
  // The attempt number is in the message on purpose: Sentry drops an event
  // identical to the previous one, and a person who retries three times in a
  // row is exactly who we need every attempt from. The fingerprint keeps them
  // in one issue.
  captureRendererMessage(`Dictation ended without a transcript (attempt ${session.attempt})`, {
    fingerprint: ['dictation', 'no-transcript'],
    level: 'warning',
    tags: {
      feature: 'dictation',
      stage: 'no_transcript',
      provider: session.provider,
      socket: stats.socketOpened ? 'opened' : 'never_opened',
      audio: stats.peakSample > SILENT_PEAK_SAMPLE ? 'audible' : 'silent',
      capture: session.captureKind ?? 'unknown',
    },
    extra: describeSession(session),
  })
}

interface UseVoiceInputOptions {
  onTranscriptUpdate: (text: string) => void
}

interface SttCredentials {
  provider: VoiceProvider
  token: string
}

interface VoiceConfiguredStatus {
  configured: boolean
  supportsVoiceAgent: boolean
  supportsTts: boolean
  /** Read-aloud voices the configured provider offers; empty when it cannot speak. */
  voices: TtsVoiceInfo[]
  /** The deployment's default among them (for anyone without their own pick). */
  defaultVoice?: string
}

const NOT_CONFIGURED: VoiceConfiguredStatus = { configured: false, supportsVoiceAgent: false, supportsTts: false, voices: [] }

function useVoiceConfiguredStatus(): VoiceConfiguredStatus {
  const { data } = useQuery<VoiceConfiguredStatus>({
    queryKey: ['voice-configured'],
    queryFn: async () => {
      const res = await apiFetch('/api/voice/configured')
      if (!res.ok) return NOT_CONFIGURED
      return res.json() as Promise<VoiceConfiguredStatus>
    },
    staleTime: 60_000,
  })
  return data ?? NOT_CONFIGURED
}

/** Hook to check whether voice input is fully configured (provider + API key). */
export function useIsVoiceConfigured(): boolean {
  return useVoiceConfiguredStatus().configured
}

/**
 * Hook to check whether the configured STT provider supports Voice Agent (S2S)
 * sessions. Returns false if STT is not configured at all.
 */
export function useIsVoiceAgentConfigured(): boolean {
  return useVoiceConfiguredStatus().supportsVoiceAgent
}

/**
 * Hook to check whether the configured voice provider can read text aloud.
 * Returns false if voice is not configured at all.
 */
export function useIsTtsConfigured(): boolean {
  return useVoiceConfiguredStatus().supportsTts
}

/**
 * The read-aloud voices the configured provider offers, and the deployment's
 * default among them. Served to every user (the settings endpoint itself is
 * admin-only in auth mode).
 */
export function useTtsVoices(): { voices: TtsVoiceInfo[]; defaultVoice: string | undefined } {
  const { voices, defaultVoice } = useVoiceConfiguredStatus()
  return { voices, defaultVoice }
}

/**
 * Whether voice mode (talk, and hear the replies) can be offered here: the
 * configured provider both transcribes and speaks, and this browser has a
 * microphone API.
 */
export function useCanUseVoiceMode(): boolean {
  const { configured, supportsTts } = useVoiceConfiguredStatus()
  const hasMic = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  return configured && supportsTts && hasMic
}

export function useVoiceInput({ onTranscriptUpdate }: UseVoiceInputOptions) {
  const [state, setState] = useState<VoiceInputState>('idle')
  const [error, setError] = useState<string | null>(null)
  const { track } = useAnalyticsTracking()

  const adapterRef = useRef<SttAdapter | null>(null)
  const captureRef = useRef<AudioCaptureHandle | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const stateRef = useRef<VoiceInputState>('idle')
  // True for the duration of a stopRecording() call so a second trigger
  // (submit + button, or an error callback) can't start a second finish.
  const stoppingRef = useRef(false)
  // Per-attempt token. Bumped by each startRecording and on unmount, so an
  // in-flight startRecording whose awaits resolve after a stop/restart or after
  // the component unmounts can detect it's stale and release what it acquired
  // instead of resurrecting a session nobody owns.
  const generationRef = useRef(0)
  // The attempt in progress, as the error reports describe it.
  const sessionRef = useRef<DictationSession | null>(null)
  // Attempts started on this page, numbering each report.
  const attemptsRef = useRef(0)

  // Keep stateRef in sync so callbacks always see the latest value
  stateRef.current = state

  // Track text accumulation across interim/final events
  const prefixRef = useRef('')
  const finalizedRef = useRef('')
  const interimRef = useRef('')

  const isSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  const cleanup = useCallback(() => {
    // Tearing down invalidates the current attempt, so an in-flight startRecording
    // whose awaits resolve afterward sees a stale generation and bails.
    generationRef.current++
    captureRef.current?.cleanup()
    captureRef.current = null
    analyserRef.current = null

    adapterRef.current?.close()
    adapterRef.current = null
    sessionRef.current = null
  }, [])

  /**
   * Stop recording and resolve with the final text. Releases the mic immediately,
   * then keeps the adapter alive long enough to flush any audio buffered during
   * the handshake and collect the server's trailing transcripts (bounded by the
   * adapter's own finish() timeout) so the tail of the utterance isn't lost.
   */
  const stopRecording = useCallback(async (): Promise<string | undefined> => {
    const st = stateRef.current
    if (stoppingRef.current || (st !== 'recording' && st !== 'connecting')) return undefined
    stoppingRef.current = true
    setState('finalizing')

    // Release the mic right away; keep the adapter to flush + await finals.
    captureRef.current?.cleanup()
    captureRef.current = null
    analyserRef.current = null

    // Detach the adapter before awaiting so late error/connect callbacks (which
    // guard on adapter identity) treat this session as already gone.
    const adapter = adapterRef.current
    adapterRef.current = null
    const session = sessionRef.current
    sessionRef.current = null
    await adapter?.finish().catch(() => {}) // finish() never rejects; guard anyway

    // Include both finalized and any pending interim text
    const prefix = prefixRef.current
    const finalized = finalizedRef.current
    const interim = interimRef.current
    prefixRef.current = ''
    finalizedRef.current = ''
    interimRef.current = ''
    const transcribed = (finalized + (interim ? (finalized ? ' ' : '') + interim : '')).trimEnd()
    if (session) {
      addRendererBreadcrumb('dictation', 'stopped', { transcribedChars: transcribed.length, ...describeSession(session) })
      if (!transcribed && !session.failed) reportNoTranscript(session)
    }
    // If nothing was transcribed, restore original text (prefix without trailing space)
    const finalText = transcribed
      ? prefix + transcribed
      : prefix.trimEnd()
    onTranscriptUpdate(finalText)
    if (transcribed) {
      track('dictation_used', { length: transcribed.length })
    }
    setState('idle')
    stoppingRef.current = false
    return finalText
  }, [onTranscriptUpdate, track])

  const startRecording = useCallback(async (existingText: string) => {
    if (stateRef.current !== 'idle') return
    setError(null)

    // Claim this attempt. If the generation moves on (restart or unmount) while
    // we're awaiting below, isStale() is true and we bail without resurrecting.
    const generation = ++generationRef.current
    const isStale = () => generation !== generationRef.current

    // Save prefix (text already in textarea before recording)
    prefixRef.current = existingText ? existingText + ' ' : ''
    finalizedRef.current = ''
    interimRef.current = ''

    setState('connecting')

    // Request the mic right away so permission/hardware spin-up runs in
    // parallel with the token round-trip instead of after it.
    const streamPromise = acquireMicStream()
    // Observe the rejection synchronously: a fast getUserMedia failure (denied
    // permission, no device) during the token round-trip would otherwise fire an
    // unhandledrejection before a handler is attached below. The error is still
    // surfaced via the awaits/releaseStream that consume the promise.
    streamPromise.catch(() => {})
    const releaseStream = () => {
      streamPromise.then((stream) => {
        if (captureRef.current?.stream !== stream) stream.getTracks().forEach((t) => t.stop())
      }).catch(() => {})
    }

    let provider: VoiceProvider | undefined
    try {
      // 1. Get API key from backend
      const credRes = await apiFetch('/api/voice/token')
      const credData: SttCredentials | { error: string } = await credRes.json()
      if (!credRes.ok) {
        throw new Error(('error' in credData ? credData.error : null) || 'Failed to get STT credentials')
      }
      const credentials = credData as SttCredentials
      provider = credentials.provider
      const token = credentials.token
      addRendererBreadcrumb('dictation', 'credentials received', { provider })

      // Bail if a stop/restart or unmount happened while fetching the token.
      // Cast needed because TS narrows the ref, but callbacks can mutate it during awaits.
      if (isStale() || (stateRef.current as VoiceInputState) !== 'connecting') {
        releaseStream()
        return
      }

      // 2. Create adapter and wire transcript events
      const adapter = createSttAdapter(provider)
      adapterRef.current = adapter
      const session: DictationSession = { provider, attempt: ++attemptsRef.current, startedAt: Date.now(), adapter, failed: false }
      sessionRef.current = session

      adapter.onTranscript((event) => {
        switch (event.type) {
          case 'interim':
            interimRef.current = event.text
            onTranscriptUpdate(prefixRef.current + finalizedRef.current + interimRef.current)
            break
          case 'final':
            finalizedRef.current += (finalizedRef.current ? ' ' : '') + event.text
            interimRef.current = ''
            onTranscriptUpdate(prefixRef.current + finalizedRef.current)
            break
          case 'speech_ended':
            break
        }
      })

      adapter.onError((err) => {
        if (adapterRef.current !== adapter) return // stale/orphaned adapter — don't touch the live session
        console.error('STT adapter error:', err)
        reportSessionFailure(session, provider, 'stream', err)
        setError(err.message)
        stopRecording()
      })

      // 3. Connect in the background — the adapter buffers audio sent before
      // the socket opens, so recording can start while the handshake is in flight.
      adapter.connect(token).catch((err: unknown) => {
        if (adapterRef.current !== adapter) return // recording already stopped
        const message = err instanceof Error ? err.message : 'Failed to connect'
        console.error('STT connect error:', err)
        reportSessionFailure(session, provider, 'connect', err)
        setError(message)
        stopRecording()
      })

      // 4. Start mic capture and pipe audio to the adapter
      const capture = await startAudioCapture(adapter, await streamPromise, { withAnalyser: true })
      // Stale (restart/unmount) or superseded: tear down everything we acquired —
      // nobody else holds these, so we own the cleanup.
      if (isStale() || adapterRef.current !== adapter || (stateRef.current as VoiceInputState) !== 'connecting') {
        capture.cleanup()
        adapter.close()
        if (adapterRef.current === adapter) adapterRef.current = null
        if (sessionRef.current === session) sessionRef.current = null
        releaseStream()
        return
      }
      captureRef.current = capture
      analyserRef.current = capture.analyser
      session.captureKind = capture.captureKind
      session.contextSampleRate = capture.audioContext.sampleRate
      session.track = describeTrack(capture.stream)
      addRendererBreadcrumb('dictation', 'capture started', {
        provider,
        captureKind: session.captureKind,
        contextSampleRate: session.contextSampleRate,
        track: session.track,
      })

      setState('recording')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start recording'
      console.error('Voice input error:', err)
      reportSessionFailure(sessionRef.current, provider, sessionRef.current ? 'capture' : 'credentials', err)
      setError(message)
      releaseStream()
      cleanup()
      // Restore original text that was in the textarea before recording started
      onTranscriptUpdate(existingText)
      prefixRef.current = ''
      finalizedRef.current = ''
      interimRef.current = ''
      setState('idle')
    }
  }, [cleanup, onTranscriptUpdate, stopRecording])

  // Cleanup on unmount (also bumps the generation, invalidating any in-flight start)
  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  const clearError = useCallback(() => setError(null), [])

  return {
    state,
    isRecording: state === 'recording',
    isConnecting: state === 'connecting',
    isFinalizing: state === 'finalizing',
    error,
    clearError,
    isSupported,
    analyserRef,
    startRecording,
    stopRecording,
  }
}
