import { addRendererBreadcrumb } from '@renderer/lib/error-reporting'
import { float32ToInt16 } from './pcm'

/** Where captured audio goes: an STT adapter. */
export interface AudioSink {
  sendAudio(chunk: ArrayBuffer): void
}

export type CaptureKind = 'worklet' | 'script-processor'

export interface AudioCaptureHandle {
  stream: MediaStream
  audioContext: AudioContext
  analyser: AnalyserNode
  /** Which node is delivering the samples (the worklet, or its fallback). */
  captureKind: CaptureKind
  /** Redirect the captured audio (a reconnected adapter), or drop it (null). */
  setSink: (sink: AudioSink | null) => void
  cleanup: () => void
}

/** Samples per chunk handed to the sink: 128 ms at 16 kHz, as the ScriptProcessor always sent. */
const CAPTURE_CHUNK_SAMPLES = 2048

/**
 * The capture worklet: gathers the 128-frame render quanta into chunks and
 * posts each one. Runs on the audio thread, so it keeps up where a
 * ScriptProcessor (main thread) does not: Safari starves the latter down to
 * a fifth of its callbacks, and the transcript comes out as fragments.
 */
const CAPTURE_WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(${CAPTURE_CHUNK_SAMPLES})
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.filled++] = channel[i]
        if (this.filled === this.buffer.length) {
          const chunk = this.buffer
          this.buffer = new Float32Array(chunk.length)
          this.filled = 0
          this.port.postMessage(chunk, [chunk.buffer])
        }
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor)
`
let captureWorkletUrl: string | null = null

interface CaptureNode {
  node: AudioNode
  kind: CaptureKind
  disconnect: () => void
}

/**
 * The node that hands captured samples to `onChunk`: an AudioWorklet where
 * the browser has one, else the deprecated ScriptProcessor.
 */
async function createCaptureNode(audioContext: AudioContext, onChunk: (samples: Float32Array) => void): Promise<CaptureNode> {
  if (audioContext.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      captureWorkletUrl ??= URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }))
      await audioContext.audioWorklet.addModule(captureWorkletUrl)
      const node = new AudioWorkletNode(audioContext, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
      node.port.onmessage = (event: MessageEvent<Float32Array>) => onChunk(event.data)
      return {
        node,
        kind: 'worklet',
        disconnect: () => {
          node.port.onmessage = null
          node.disconnect()
        },
      }
    } catch (err) {
      console.warn('Audio capture worklet unavailable, falling back to ScriptProcessor:', err)
      addRendererBreadcrumb('dictation', 'capture worklet unavailable, using ScriptProcessor', {
        reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      })
    }
  }
  const processor = audioContext.createScriptProcessor(CAPTURE_CHUNK_SAMPLES, 1, 1)
  processor.onaudioprocess = (e) => onChunk(e.inputBuffer.getChannelData(0))
  return {
    node: processor,
    kind: 'script-processor',
    disconnect: () => {
      processor.onaudioprocess = null
      processor.disconnect()
    },
  }
}

/**
 * Request microphone access. Split out from startAudioCapture so callers can
 * start acquiring the mic in parallel with credential/connection setup.
 *
 * No sampleRate constraint: browsers treat it as a hint and capture at the
 * hardware's native rate regardless; the AudioContext in startAudioCapture
 * (created at the provider's required rate) does the actual resampling.
 */
export async function acquireMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  })
}

/**
 * Set up microphone capture and pipe 16-bit PCM chunks to `sink` (an STT
 * adapter), at the sink's sample rate (16 kHz unless it says otherwise). Returns handles for the resources and a cleanup function. The
 * caller owns the passed-in stream (acquire via acquireMicStream) and is
 * responsible for releasing it if this rejects; on success the returned
 * cleanup() stops it.
 */
export async function startAudioCapture(
  sink: AudioSink & { readonly sampleRate?: number },
  stream: MediaStream,
  options?: { withAnalyser?: boolean },
): Promise<AudioCaptureHandle> {
  const sampleRate = sink.sampleRate ?? 16000

  const audioContext = new AudioContext({ sampleRate })
  // The context may start suspended if created outside a synchronous user-gesture
  // handler (e.g. after awaiting network requests). Explicitly resume it.
  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }
  const source = audioContext.createMediaStreamSource(stream)

  const analyser = audioContext.createAnalyser()
  if (options?.withAnalyser) {
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser)
  }

  let currentSink: AudioSink | null = sink
  const capture = await createCaptureNode(audioContext, (samples) => {
    currentSink?.sendAudio(float32ToInt16(samples).buffer as ArrayBuffer)
  })
  source.connect(capture.node)
  capture.node.connect(audioContext.destination)

  const cleanup = () => {
    currentSink = null
    capture.disconnect()
    audioContext.close()
    stream.getTracks().forEach(t => t.stop())
  }

  return {
    stream,
    audioContext,
    analyser,
    captureKind: capture.kind,
    setSink: (next) => {
      currentSink = next
    },
    cleanup,
  }
}
