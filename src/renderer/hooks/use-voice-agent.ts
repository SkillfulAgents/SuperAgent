import { useState, useRef, useCallback, useEffect } from 'react'
import { apiFetch } from '@renderer/lib/api'
import {
  createVoiceAgentAdapter,
  type VoiceAgentAdapter,
  type VoiceAgentConfig,
  type VoiceAgentEvent,
  type SttProvider,
} from '@renderer/lib/voice-agent'
import { float32ToInt16 } from '@renderer/lib/stt'

export type VoiceAgentState = 'idle' | 'connecting' | 'active' | 'error'
export type SpeakingState = 'none' | 'user' | 'agent'

export interface VoiceAgentTranscriptEntry {
  role: 'user' | 'assistant'
  text: string
}

interface VoiceAgentCredentials {
  provider: SttProvider
  token: string
}

interface UseVoiceAgentOptions {
  config: VoiceAgentConfig
  /** Called when the agent invokes a function call (structured output) */
  onFunctionCall?: (name: string, args: string) => void
  /** Called on error */
  onError?: (message: string) => void
}

export function useVoiceAgent({ config, onFunctionCall, onError }: UseVoiceAgentOptions) {
  const [state, setState] = useState<VoiceAgentState>('idle')
  const [speakingState, setSpeakingState] = useState<SpeakingState>('none')
  const [transcript, setTranscript] = useState<VoiceAgentTranscriptEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const adapterRef = useRef<VoiceAgentAdapter | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const playbackContextRef = useRef<AudioContext | null>(null)
  const playbackAnalyserRef = useRef<AnalyserNode | null>(null)
  const nextPlaybackTimeRef = useRef(0)
  const speakingDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const stateRef = useRef<VoiceAgentState>('idle')
  const mutedRef = useRef(false)
  const pendingFunctionCallRef = useRef<{ name: string; arguments: string } | null>(null)
  const audioDrainedRef = useRef(true) // true when no audio is in flight

  // Keep refs in sync
  stateRef.current = state

  // Stable refs for callbacks
  const onFunctionCallRef = useRef(onFunctionCall)
  onFunctionCallRef.current = onFunctionCall
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const cleanupAudio = useCallback(() => {
    processorRef.current?.disconnect()
    processorRef.current = null

    audioContextRef.current?.close()
    audioContextRef.current = null

    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null

    analyserRef.current = null

    playbackAnalyserRef.current = null
    playbackContextRef.current?.close()
    playbackContextRef.current = null

    if (speakingDoneTimerRef.current) {
      clearTimeout(speakingDoneTimerRef.current)
      speakingDoneTimerRef.current = null
    }
  }, [])

  const cleanup = useCallback(() => {
    cleanupAudio()
    adapterRef.current?.close()
    adapterRef.current = null
    pendingFunctionCallRef.current = null
    audioDrainedRef.current = true
  }, [cleanupAudio])

  const handleEvent = useCallback((event: VoiceAgentEvent) => {
    switch (event.type) {
      case 'user_speaking': {
        // Cancel any pending "done" timer — user is still talking
        if (speakingDoneTimerRef.current) {
          clearTimeout(speakingDoneTimerRef.current)
          speakingDoneTimerRef.current = null
        }
        // Flush any queued agent audio — user is interrupting (barge-in)
        const oldCtx = playbackContextRef.current
        if (oldCtx) {
          const rate = adapterRef.current?.outputSampleRate ?? 24000
          void oldCtx.close()
          const newCtx = new AudioContext({ sampleRate: rate })
          playbackContextRef.current = newCtx
          playbackAnalyserRef.current = createPlaybackAnalyser(newCtx)
          nextPlaybackTimeRef.current = 0
        }
        setSpeakingState('user')
        break
      }

      case 'user_stopped_speaking':
        // Don't immediately clear — wait briefly in case it's just a pause
        if (speakingDoneTimerRef.current) clearTimeout(speakingDoneTimerRef.current)
        speakingDoneTimerRef.current = setTimeout(() => {
          setSpeakingState((prev) => prev === 'user' ? 'none' : prev)
        }, 500)
        break

      case 'agent_thinking':
        if (speakingDoneTimerRef.current) {
          clearTimeout(speakingDoneTimerRef.current)
          speakingDoneTimerRef.current = null
        }
        setSpeakingState('none')
        break

      case 'agent_audio': {
        // Cancel any pending "done" timer — more audio is arriving
        if (speakingDoneTimerRef.current) {
          clearTimeout(speakingDoneTimerRef.current)
          speakingDoneTimerRef.current = null
        }
        audioDrainedRef.current = false
        setSpeakingState('agent')
        // Play audio through the playback context, scheduling chunks sequentially
        const ctx = playbackContextRef.current
        if (ctx && ctx.state !== 'closed') {
          const adapter = adapterRef.current
          if (!adapter) break
          const float32 = pcm16ToFloat32(event.audio)
          const buffer = ctx.createBuffer(1, float32.length, adapter.outputSampleRate)
          buffer.copyToChannel(float32 as Float32Array<ArrayBuffer>, 0)
          const source = ctx.createBufferSource()
          source.buffer = buffer
          // Route through the playback analyser (which is connected to destination)
          // so the UI can visualize the agent's audio output.
          const destination = playbackAnalyserRef.current ?? ctx.destination
          source.connect(destination)

          // Schedule this chunk to play after the previous one finishes
          const now = ctx.currentTime
          if (nextPlaybackTimeRef.current < now) {
            nextPlaybackTimeRef.current = now
          }
          source.start(nextPlaybackTimeRef.current)
          nextPlaybackTimeRef.current += buffer.duration
        }
        break
      }

      case 'agent_audio_done': {
        // Server is done sending audio, but playback may still be in progress.
        // Keep the speaking indicator alive until scheduled playback finishes.
        const ctx = playbackContextRef.current
        const remainingMs = ctx
          ? Math.max(0, (nextPlaybackTimeRef.current - ctx.currentTime) * 1000)
          : 0
        nextPlaybackTimeRef.current = 0
        if (speakingDoneTimerRef.current) clearTimeout(speakingDoneTimerRef.current)
        const drainMs = remainingMs + 100 // small buffer for safety
        speakingDoneTimerRef.current = setTimeout(() => {
          setSpeakingState((prev) => prev === 'agent' ? 'none' : prev)
          audioDrainedRef.current = true
          // Flush any pending function call now that audio has finished
          const pending = pendingFunctionCallRef.current
          if (pending) {
            pendingFunctionCallRef.current = null
            onFunctionCallRef.current?.(pending.name, pending.arguments)
          }
        }, drainMs)
        break
      }

      case 'transcript':
        if (event.final) {
          setTranscript((prev) => [...prev, { role: event.role, text: event.text }])
        }
        break

      case 'function_call':
        // Defer the callback until audio playback finishes so the agent's
        // final spoken phrase isn't cut off when the consumer unmounts us.
        if (audioDrainedRef.current) {
          // No audio in flight — fire after a short grace period
          onFunctionCallRef.current?.(event.name, event.arguments)
        } else {
          // Audio still playing — stash and let agent_audio_done flush it
          pendingFunctionCallRef.current = { name: event.name, arguments: event.arguments }
        }
        break

      case 'error':
        setError(event.message)
        onErrorRef.current?.(event.message)
        break

      case 'disconnected':
        if (stateRef.current === 'active' || stateRef.current === 'connecting') {
          setState('idle')
          setSpeakingState('none')
        }
        break
    }
  }, [])

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return
    setError(null)
    setTranscript([])
    setState('connecting')

    try {
      // 1. Get Voice Agent token
      const credRes = await apiFetch('/api/stt/voice-agent-token')
      const credData: VoiceAgentCredentials | { error: string } = await credRes.json()
      if (!credRes.ok) {
        throw new Error(('error' in credData ? credData.error : null) || 'Failed to get Voice Agent credentials')
      }
      const { provider, token } = credData as VoiceAgentCredentials

      // 2. Create adapter
      const adapter = createVoiceAgentAdapter(provider)
      adapterRef.current = adapter
      adapter.onEvent(handleEvent)

      // 3. Connect
      await adapter.connect(token, config)

      // 4. Set up audio capture
      const sampleRate = adapter.inputSampleRate
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      streamRef.current = stream

      const audioContext = new AudioContext({ sampleRate })
      if (audioContext.state === 'suspended') {
        await audioContext.resume()
      }
      audioContextRef.current = audioContext

      const source = audioContext.createMediaStreamSource(stream)

      // Set up analyser for visualization
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
      analyserRef.current = analyser

      // Set up processor to pipe audio to adapter
      const processor = audioContext.createScriptProcessor(2048, 1, 1)
      processor.onaudioprocess = (e) => {
        if (mutedRef.current) return
        const float32 = e.inputBuffer.getChannelData(0)
        adapter.sendAudio(float32ToInt16(float32).buffer as ArrayBuffer)
      }
      processorRef.current = processor
      source.connect(processor)
      processor.connect(audioContext.destination)

      // 5. Set up audio playback context with an analyser for visualization
      const playbackCtx = new AudioContext({ sampleRate: adapter.outputSampleRate })
      playbackContextRef.current = playbackCtx
      playbackAnalyserRef.current = createPlaybackAnalyser(playbackCtx)

      // Guard against race condition: if stop() was called while we were
      // awaiting, clean up everything we just created to avoid leaked resources
      if ((stateRef.current as VoiceAgentState) !== 'connecting') {
        processor.disconnect()
        audioContext.close()
        stream.getTracks().forEach(t => t.stop())
        playbackContextRef.current?.close()
        playbackContextRef.current = null
        playbackAnalyserRef.current = null
        adapter.close()
        adapterRef.current = null
        return
      }

      setState('active')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start Voice Agent'
      console.error('Voice Agent error:', err)
      setError(message)
      onErrorRef.current?.(message)
      cleanup()
      setState('idle')
    }
  }, [config, cleanup, handleEvent])

  const stop = useCallback(() => {
    cleanup()
    setState('idle')
    setSpeakingState('none')
  }, [cleanup])

  const pause = useCallback(() => {
    mutedRef.current = true
    // Suspend audio playback
    void playbackContextRef.current?.suspend()
  }, [])

  const resume = useCallback(() => {
    mutedRef.current = false
    // Resume audio playback
    void playbackContextRef.current?.resume()
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => { cleanup() }
  }, [cleanup])

  return {
    state,
    speakingState,
    transcript,
    error,
    analyserRef,
    playbackAnalyserRef,
    start,
    stop,
    pause,
    resume,
    isActive: state === 'active',
    isConnecting: state === 'connecting',
  }
}

/** Convert Int16 PCM audio buffer to Float32 samples for Web Audio playback */
function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const int16 = new Int16Array(buffer)
  const float32 = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 0x8000
  }
  return float32
}

/** Build an AnalyserNode for visualizing agent audio playback and wire it to the context destination. */
function createPlaybackAnalyser(ctx: AudioContext): AnalyserNode {
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.6
  analyser.connect(ctx.destination)
  return analyser
}
