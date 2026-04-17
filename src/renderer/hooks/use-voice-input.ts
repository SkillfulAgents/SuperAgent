import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
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

  const startRecording = useCallback(async (existingText: string) => {
    if (stateRef.current !== 'idle') return
    setError(null)

    // Save prefix (text already in textarea before recording)
    prefixRef.current = existingText ? existingText + ' ' : ''
    finalizedRef.current = ''
    interimRef.current = ''

    setState('connecting')

    try {
      // 1. Get API key from backend
      const credRes = await apiFetch('/api/stt/token')
      const credData: SttCredentials | { error: string } = await credRes.json()
      if (!credRes.ok) {
        throw new Error(('error' in credData ? credData.error : null) || 'Failed to get STT credentials')
      }
      const { provider, token } = credData as SttCredentials

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
        console.error('STT adapter error:', err)
        setError(err.message)
        stopRecording()
      })

      await adapter.connect(token)

      // 3. Start mic capture and pipe audio to the adapter
      captureRef.current = await startAudioCapture(adapter, { withAnalyser: true })
      analyserRef.current = captureRef.current.analyser

      // Guard against race: if an error callback already triggered stopRecording
      // while we were awaiting above, don't overwrite the idle state.
      // Cast needed because TS narrows the ref, but callbacks can mutate it during awaits.
      if ((stateRef.current as VoiceInputState) !== 'connecting') return

      setState('recording')
    } catch (err) {
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
  }, [cleanup, onTranscriptUpdate, stopRecording])

  // Cleanup on unmount
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
    error,
    clearError,
    isSupported,
    analyserRef,
    startRecording,
    stopRecording,
  }
}
