import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { createSttAdapter, startAudioCapture, type SttAdapter, type SttProvider, type AudioCaptureHandle } from '@renderer/lib/stt'

export type VoiceInputState = 'idle' | 'connecting' | 'recording' | 'stopping'

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

// React Query cache key for the ephemeral STT token. Invalidated on
// voice-settings changes (provider switch / key save). The backend mints a
// short-lived token; 5 min stale is comfortably under the typical TTL.
const STT_TOKEN_QUERY_KEY = ['stt-token'] as const
const STT_TOKEN_STALE_MS = 300_000

async function fetchSttToken(): Promise<SttCredentials> {
  const res = await apiFetch('/api/stt/token')
  const data: SttCredentials | { error: string } = await res.json()
  if (!res.ok) {
    throw new Error(('error' in data ? data.error : null) || 'Failed to get STT credentials')
  }
  return data as SttCredentials
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
  const queryClient = useQueryClient()
  const hasVoiceConfigured = useIsVoiceConfigured()

  const adapterRef = useRef<SttAdapter | null>(null)
  const captureRef = useRef<AudioCaptureHandle | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const stateRef = useRef<VoiceInputState>('idle')

  // Keep stateRef in sync so callbacks always see the latest value
  stateRef.current = state

  // Track text accumulation across interim/final events
  const prefixRef = useRef('')
  const finalizedRef = useRef('')
  const interimRef = useRef('')

  const isSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  const cleanup = useCallback(() => {
    captureRef.current?.cleanup()
    captureRef.current = null
    analyserRef.current = null

    adapterRef.current?.close()
    adapterRef.current = null
  }, [])

  /** Stop recording and return the final text (including any pending interim transcript). */
  const stopRecording = useCallback((): string | undefined => {
    if (stateRef.current !== 'recording' && stateRef.current !== 'connecting') return undefined
    setState('stopping')

    cleanup()
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
    return finalText
  }, [cleanup, onTranscriptUpdate, track])

  /**
   * Speculatively fetch and cache an STT token. Safe to call repeatedly —
   * React Query dedupes in-flight requests and skips the network when the
   * cache is fresh. Call this when the user is likely to click the mic soon
   * (e.g. on composer focus) so the click path doesn't pay for token minting.
   */
  const prefetchToken = useCallback(() => {
    if (!hasVoiceConfigured) return
    void queryClient.prefetchQuery({
      queryKey: STT_TOKEN_QUERY_KEY,
      queryFn: fetchSttToken,
      staleTime: STT_TOKEN_STALE_MS,
    })
  }, [hasVoiceConfigured, queryClient])

  const startRecording = useCallback(async (existingText: string) => {
    if (stateRef.current !== 'idle') return
    setError(null)

    // Save prefix (text already in textarea before recording)
    prefixRef.current = existingText ? existingText + ' ' : ''
    finalizedRef.current = ''
    interimRef.current = ''

    setState('connecting')
    const t0 = performance.now()

    try {
      // Fire token fetch and mic permission in parallel — they don't depend
      // on each other, so the combined wait collapses to max(token, mic)
      // instead of their sum. With a warm token cache (composer-focus
      // prefetch), this typically resolves in just the getUserMedia time.
      const tokenPromise = queryClient.ensureQueryData({
        queryKey: STT_TOKEN_QUERY_KEY,
        queryFn: fetchSttToken,
        staleTime: STT_TOKEN_STALE_MS,
      })
      // No sampleRate hint — we don't know the provider yet, and the
      // AudioContext resamples the stream to whatever rate we need.
      const audioPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })

      const [credData, stream] = await Promise.all([tokenPromise, audioPromise])
      const { provider, token } = credData

      // Create adapter and wire transcript events before kicking off connect,
      // so we don't miss any messages.
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
        console.error('STT adapter error:', err)
        setError(err.message)
        stopRecording()
      })

      // Kick off the WebSocket handshake. Don't await yet — audio capture
      // starts in parallel and the adapter buffers chunks until the WS opens.
      const connectPromise = adapter.connect(token)
      // Prevent unhandled-rejection warnings if we abort before awaiting below.
      connectPromise.catch(() => {})

      // Pipe the pre-acquired mic stream into the adapter. The first audio
      // chunks fire immediately and go into the adapter's pre-buffer; they
      // drain to the WS as soon as it opens.
      captureRef.current = await startAudioCapture(adapter, { withAnalyser: true, stream })
      analyserRef.current = captureRef.current.analyser

      // If stopRecording fired during the awaits above, bail without
      // overwriting the idle/stopping state.
      if ((stateRef.current as VoiceInputState) !== 'connecting') return

      // Optimistic state flip: the mic is live and audio is flowing into the
      // pre-buffer. The WS may still be handshaking, but the user can start
      // speaking now — their first words won't be lost.
      setState('recording')

      // Wait for the WS to actually open before considering the start
      // successful. If it fails, the catch below rolls back state and
      // surfaces the error.
      await connectPromise

      track('dictation_start_timing', {
        click_to_recording_ms: Math.round(performance.now() - t0),
        provider,
      })
    } catch (err) {
      // If the user (or the error callback) already stopped recording during
      // an await, state is now 'stopping' or 'idle' and cleanup has already
      // run — don't surface a misleading error.
      // Cast needed because TS narrows the ref, but callbacks can mutate it during awaits.
      const currentState = stateRef.current as VoiceInputState
      if (currentState === 'stopping' || currentState === 'idle') {
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to start recording'
      console.error('Voice input error:', err)
      setError(message)
      cleanup()
      // Restore original text that was in the textarea before recording started
      onTranscriptUpdate(existingText)
      prefixRef.current = ''
      finalizedRef.current = ''
      interimRef.current = ''
      setState('idle')
    }
  }, [cleanup, onTranscriptUpdate, queryClient, stopRecording, track])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  // Speculatively warm the STT token as soon as voice is known to be
  // configured — i.e. as soon as the composer (or anything that mounts this
  // hook) appears. By the time the user clicks the mic, the token round-trip
  // is usually already done. prefetchToken itself no-ops when not configured.
  useEffect(() => {
    if (hasVoiceConfigured) {
      prefetchToken()
    }
  }, [hasVoiceConfigured, prefetchToken])

  const clearError = useCallback(() => setError(null), [])

  return {
    state,
    isRecording: state === 'recording',
    isConnecting: state === 'connecting',
    error,
    clearError,
    isSupported,
    analyserRef,
    startRecording,
    stopRecording,
    prefetchToken,
  }
}
