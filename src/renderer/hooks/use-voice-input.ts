import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { acquireMicStream, createSttAdapter, startAudioCapture, type SttAdapter, type SttProvider, type AudioCaptureHandle } from '@renderer/lib/stt'

// 'finalizing': mic released, but we're flushing buffered audio and awaiting the
// server's trailing transcripts before the final text is ready.
export type VoiceInputState = 'idle' | 'connecting' | 'recording' | 'finalizing'

interface UseVoiceInputOptions {
  onTranscriptUpdate: (text: string) => void
}

interface SttCredentials {
  provider: SttProvider
  token: string
}

interface SttConfiguredStatus {
  configured: boolean
  supportsVoiceAgent: boolean
}

function useSttConfiguredStatus(): SttConfiguredStatus {
  const { data } = useQuery<SttConfiguredStatus>({
    queryKey: ['stt-configured'],
    queryFn: async () => {
      const res = await apiFetch('/api/stt/configured')
      if (!res.ok) return { configured: false, supportsVoiceAgent: false }
      return res.json() as Promise<SttConfiguredStatus>
    },
    staleTime: 60_000,
  })
  return data ?? { configured: false, supportsVoiceAgent: false }
}

/** Hook to check whether voice input is fully configured (provider + API key). */
export function useIsVoiceConfigured(): boolean {
  return useSttConfiguredStatus().configured
}

/**
 * Hook to check whether the configured STT provider supports Voice Agent (S2S)
 * sessions. Returns false if STT is not configured at all.
 */
export function useIsVoiceAgentConfigured(): boolean {
  return useSttConfiguredStatus().supportsVoiceAgent
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
    await adapter?.finish().catch(() => {}) // finish() never rejects; guard anyway

    // Include both finalized and any pending interim text
    const prefix = prefixRef.current
    const finalized = finalizedRef.current
    const interim = interimRef.current
    prefixRef.current = ''
    finalizedRef.current = ''
    interimRef.current = ''
    const transcribed = (finalized + (interim ? (finalized ? ' ' : '') + interim : '')).trimEnd()
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

    try {
      // 1. Get API key from backend
      const credRes = await apiFetch('/api/stt/token')
      const credData: SttCredentials | { error: string } = await credRes.json()
      if (!credRes.ok) {
        throw new Error(('error' in credData ? credData.error : null) || 'Failed to get STT credentials')
      }
      const { provider, token } = credData as SttCredentials

      // Bail if a stop/restart or unmount happened while fetching the token.
      // Cast needed because TS narrows the ref, but callbacks can mutate it during awaits.
      if (isStale() || (stateRef.current as VoiceInputState) !== 'connecting') {
        releaseStream()
        return
      }

      // 2. Create adapter and wire transcript events
      const adapter = createSttAdapter(provider)
      adapterRef.current = adapter

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
        setError(err.message)
        stopRecording()
      })

      // 3. Connect in the background — the adapter buffers audio sent before
      // the socket opens, so recording can start while the handshake is in flight.
      adapter.connect(token).catch((err: unknown) => {
        if (adapterRef.current !== adapter) return // recording already stopped
        const message = err instanceof Error ? err.message : 'Failed to connect'
        console.error('STT connect error:', err)
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
        releaseStream()
        return
      }
      captureRef.current = capture
      analyserRef.current = capture.analyser

      setState('recording')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start recording'
      console.error('Voice input error:', err)
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
