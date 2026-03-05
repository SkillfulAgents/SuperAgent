import { useState, useRef, useCallback, useEffect } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { createSttAdapter, type SttAdapter, type SttProvider } from '@renderer/lib/stt'

export type VoiceInputState = 'idle' | 'connecting' | 'recording' | 'stopping'

interface UseVoiceInputOptions {
  onTranscriptUpdate: (text: string) => void
  agentSlug?: string
}

interface SttCredentials {
  provider: SttProvider
  token: string
}

export function useVoiceInput({ onTranscriptUpdate, agentSlug }: UseVoiceInputOptions) {
  const [state, setState] = useState<VoiceInputState>('idle')
  const [error, setError] = useState<string | null>(null)

  const adapterRef = useRef<SttAdapter | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | AudioWorkletNode | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)

  // Track text accumulation across interim/final events
  const prefixRef = useRef('')
  const finalizedRef = useRef('')
  const interimRef = useRef('')

  // Track recording duration for usage reporting
  const recordingStartRef = useRef<number>(0)
  const providerRef = useRef<SttProvider | null>(null)

  const isSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  const cleanup = useCallback(() => {
    processorRef.current?.disconnect()
    processorRef.current = null

    audioContextRef.current?.close()
    audioContextRef.current = null

    mediaStreamRef.current?.getTracks().forEach(t => t.stop())
    mediaStreamRef.current = null

    adapterRef.current?.close()
    adapterRef.current = null
  }, [])

  const stopRecording = useCallback(() => {
    if (state !== 'recording' && state !== 'connecting') return
    setState('stopping')

    // Report usage before cleanup
    const provider = providerRef.current
    const durationMs = recordingStartRef.current > 0
      ? Date.now() - recordingStartRef.current
      : 0
    if (provider && durationMs > 0) {
      apiFetch('/api/stt/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, durationMs, agentSlug }),
      }).catch((err) => console.error('Failed to report STT usage:', err))
    }
    providerRef.current = null
    recordingStartRef.current = 0

    cleanup()
    // Drop interim text — keep only finalized content in the textarea
    const finalText = prefixRef.current + finalizedRef.current
    prefixRef.current = ''
    finalizedRef.current = ''
    interimRef.current = ''
    onTranscriptUpdate(finalText)
    setState('idle')
  }, [state, cleanup, onTranscriptUpdate, agentSlug])

  const startRecording = useCallback(async (existingText: string) => {
    if (state !== 'idle') return
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
      const { provider, token: apiKey } = credData as SttCredentials

      // 2. Create adapter
      const adapter = createSttAdapter(provider)
      adapterRef.current = adapter
      const sampleRate = adapter.sampleRate ?? 16000

      // 3. Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      mediaStreamRef.current = stream

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

      await adapter.connect(apiKey)

      providerRef.current = provider
      recordingStartRef.current = Date.now()

      // 4. Set up audio processing to send PCM chunks
      const audioContext = new AudioContext({ sampleRate })
      audioContextRef.current = audioContext
      const source = audioContext.createMediaStreamSource(stream)

      const processor = audioContext.createScriptProcessor(2048, 1, 1)
      processorRef.current = processor

      processor.onaudioprocess = (e) => {
        if (adapterRef.current) {
          const float32 = e.inputBuffer.getChannelData(0)
          // Convert Float32 [-1, 1] to Int16 PCM
          const int16 = new Int16Array(float32.length)
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]))
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
          }
          adapterRef.current.sendAudio(int16.buffer)
        }
      }

      source.connect(processor)
      processor.connect(audioContext.destination)

      setState('recording')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start recording'
      console.error('Voice input error:', err)
      setError(message)
      cleanup()
      setState('idle')
    }
  }, [state, cleanup, onTranscriptUpdate, stopRecording])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  return {
    state,
    isRecording: state === 'recording',
    isConnecting: state === 'connecting',
    error,
    isSupported,
    startRecording,
    stopRecording,
  }
}
