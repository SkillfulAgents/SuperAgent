// --- Types ---

import type { VoiceProvider } from '@shared/lib/config/settings'
import { addRendererBreadcrumb } from './error-reporting'
export type { VoiceProvider }

const CONNECT_TIMEOUT_MS = 10_000

/**
 * Cap on audio buffered while the WebSocket is still connecting
 * (~30s of int16 PCM at 16kHz, ~20s at 24kHz — well past CONNECT_TIMEOUT_MS).
 * On overflow the oldest chunks are dropped.
 */
const MAX_BUFFERED_AUDIO_BYTES = 1_000_000

/** Distinct server event types a session's stats will keep count of. */
const MAX_TRACKED_EVENT_TYPES = 32

/**
 * Upper bound on how long finish() waits for the server's trailing transcripts
 * after the audio has been flushed. The providers normally signal completion
 * sooner (Deepgram closes the socket, OpenAI sends a `completed` event); this is
 * only the backstop so a stuck connection can't hang the caller's stop/submit.
 */
const FLUSH_TIMEOUT_MS = 1_500

export interface TranscriptEvent {
  /**
   * 'finalized' answers finalize(): the server has turned everything sent so
   * far into finals (delivered as 'final' events just before it). Text is empty.
   */
  type: 'interim' | 'final' | 'speech_started' | 'speech_ended' | 'finalized'
  text: string
}

export type TranscriptCallback = (event: TranscriptEvent) => void
export type ErrorCallback = (error: Error) => void

/**
 * What happened on one adapter session, for diagnosing "I spoke and nothing
 * came back" after the fact: whether the socket ever opened, how much audio
 * went out and how loud it was, what the server sent, and how it ended.
 */
export interface SttSessionStats {
  /** The socket reached OPEN; audio can only flow after this. */
  socketOpened: boolean
  /** connect() to open, in ms. Absent when the socket never opened. */
  connectMs?: number
  /** Audio handed to the adapter, written or still buffered. */
  bytesReceived: number
  /** Audio written to the socket. */
  bytesSent: number
  /** Audio discarded because the pre-open buffer overflowed. */
  bytesDropped: number
  /** Loudest 16-bit sample seen (0..32767). 0 means the mic delivered silence. */
  peakSample: number
  /** Server events by type, so a missing or unexpected one stands out. */
  serverEvents: Record<string, number>
  /** Transcript events delivered to the caller. */
  interims: number
  finals: number
  /** Errors surfaced to the caller. */
  errors: number
  /** The last error message, surfaced or not (a late one during finish is swallowed). */
  lastError?: string
  closeCode?: number
  closeReason?: string
}

export interface SttAdapter {
  /** Required audio sample rate in Hz. Defaults to 16000 if not set. */
  readonly sampleRate?: number
  /** Running account of this session, for error reports. */
  readonly stats?: SttSessionStats
  connect(token: string): Promise<void>
  sendAudio(chunk: ArrayBuffer): void
  onTranscript(cb: TranscriptCallback): void
  onError(cb: ErrorCallback): void
  /**
   * Gracefully stop: flush any audio buffered during the handshake, ask the
   * server to finalize, and resolve once the trailing transcripts have been
   * delivered (or after FLUSH_TIMEOUT_MS). Unlike close(), this preserves the
   * tail of the utterance — callers that need the final text should await it.
   */
  finish(): Promise<void>
  /**
   * Turn the audio sent so far into final transcripts now, without closing:
   * a 'finalized' event follows the resulting finals. For a caller that wants
   * the utterance before the server's own silence detection would end it,
   * while continuing to listen. No-op with no live socket.
   */
  finalize(): void
  close(): void
}

// --- Base WebSocket adapter ---

/**
 * Shared WebSocket lifecycle for the STT adapters: pre-open audio buffering,
 * deliberate-close error suppression, and graceful finish() (flush buffered
 * audio + await the server's trailing transcripts). Subclasses supply only the
 * provider-specific bits — how to open the socket, configure the session, write
 * a chunk, finalize, and parse incoming messages.
 */
abstract class WebSocketSttAdapter implements SttAdapter {
  readonly stats: SttSessionStats = {
    socketOpened: false,
    bytesReceived: 0,
    bytesSent: 0,
    bytesDropped: 0,
    peakSample: 0,
    serverEvents: {},
    interims: 0,
    finals: 0,
    errors: 0,
  }
  protected ws: WebSocket | null = null
  private transcriptCb: TranscriptCallback | null = null
  private errorCb: ErrorCallback | null = null
  private connected = false
  private closed = false
  private finishing = false
  private finishResolve: (() => void) | null = null
  private finishTimer: ReturnType<typeof setTimeout> | null = null
  private pendingAudio: ArrayBuffer[] = []
  private pendingBytes = 0
  private connectStartedAt = 0

  /** Open the provider's WebSocket, authenticated with `token`. */
  protected abstract createSocket(token: string): WebSocket
  /** Label for the "<label> WebSocket connection failed/timed out" errors. */
  protected abstract readonly connectErrorLabel: string
  /** Label for the "<label> connection closed: ..." error. */
  protected abstract readonly closeErrorLabel: string
  /** Write one audio chunk to the already-open socket. */
  protected abstract writeAudio(chunk: ArrayBuffer): void
  /**
   * Ask the server to finalize so it emits the utterance's trailing transcripts.
   * Returns true if a finalize was sent and the caller should await completion;
   * false if there was nothing to finalize (e.g. the server already auto-committed
   * the audio), in which case finish() completes immediately instead of waiting.
   */
  protected abstract requestFinalize(): boolean
  /**
   * Ask the server for finals of the audio sent so far while keeping the
   * connection open. The subclass emits 'finalized' when they have arrived.
   */
  protected abstract requestMidStreamFinalize(): void
  /** Handle one decoded server message (transcripts, errors, completion). */
  protected abstract handleMessage(data: any): void
  /** Hook run once the socket opens, before buffered audio is flushed (e.g. session config). */
  protected onConnected(): void {}

  /** Whether a finish() is in progress (for subclasses to suppress teardown-time noise). */
  protected get isFinishing(): boolean {
    return this.finishing
  }

  async connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connectStartedAt = Date.now()
      this.ws = this.createSocket(token)

      const timeout = setTimeout(() => {
        this.ws?.close()
        reject(this.noteError(new Error(`${this.connectErrorLabel} WebSocket connection timed out`)))
      }, CONNECT_TIMEOUT_MS)

      this.ws.onopen = () => {
        clearTimeout(timeout)
        this.connected = true
        this.stats.socketOpened = true
        this.stats.connectMs = Date.now() - this.connectStartedAt
        this.onConnected()
        for (const chunk of this.pendingAudio) this.write(chunk)
        this.pendingAudio = []
        this.pendingBytes = 0
        // If finish() was requested during the handshake, finalize now that the
        // buffered audio is on its way (or complete now if there's nothing to send).
        if (this.finishing && !this.requestFinalize()) this.completeFinish()
        resolve()
      }

      this.ws.onerror = () => {
        clearTimeout(timeout)
        const err = this.noteError(new Error(`${this.connectErrorLabel} WebSocket connection failed`))
        if (!this.connected) {
          reject(err)
        } else if (!this.closed && !this.finishing) {
          this.emitError(err)
        }
      }

      this.ws.onmessage = (event) => {
        let data: any
        try {
          data = JSON.parse(event.data as string)
        } catch {
          // Ignore non-JSON messages
          return
        }
        this.noteServerEvent(data)
        this.handleMessage(data)
      }

      this.ws.onclose = (event) => {
        this.stats.closeCode = event.code
        this.stats.closeReason = event.reason
        // A close during finish() (server flushed finals / closed after commit)
        // is finish()'s completion signal.
        if (this.finishResolve) { this.completeFinish(); return }
        if (this.closed) return
        if (event.code !== 1000 && event.code !== 1005) {
          this.emitError(new Error(`${this.closeErrorLabel} connection closed: ${event.code} ${event.reason}`))
        }
      }
    })
  }

  sendAudio(chunk: ArrayBuffer): void {
    this.stats.bytesReceived += chunk.byteLength
    this.notePeak(chunk)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.write(chunk)
    } else if (!this.connected && !this.closed) {
      // Capture can start before the socket opens — buffer and flush on open
      this.pendingAudio.push(chunk)
      this.pendingBytes += chunk.byteLength
      while (this.pendingBytes > MAX_BUFFERED_AUDIO_BYTES && this.pendingAudio.length > 0) {
        const dropped = this.pendingAudio.shift()!.byteLength
        this.pendingBytes -= dropped
        this.stats.bytesDropped += dropped
      }
    }
  }

  private write(chunk: ArrayBuffer): void {
    this.writeAudio(chunk)
    this.stats.bytesSent += chunk.byteLength
  }

  private notePeak(chunk: ArrayBuffer): void {
    const samples = new Int16Array(chunk, 0, chunk.byteLength >> 1)
    let peak = this.stats.peakSample
    for (let i = 0; i < samples.length; i++) {
      const magnitude = samples[i] < 0 ? -samples[i] : samples[i]
      if (magnitude > peak) peak = magnitude
    }
    this.stats.peakSample = peak
  }

  private noteServerEvent(data: any): void {
    const type = typeof data?.type === 'string' ? data.type : 'unknown'
    const events = this.stats.serverEvents
    // Bounded: a misbehaving server cannot grow the record without limit.
    const key = type in events || Object.keys(events).length < MAX_TRACKED_EVENT_TYPES ? type : 'other'
    events[key] = (events[key] ?? 0) + 1
  }

  /** Record an error on the session, whether or not it reaches the caller. */
  protected noteError(error: Error): Error {
    this.stats.lastError = error.message
    return error
  }

  onTranscript(cb: TranscriptCallback): void {
    this.transcriptCb = cb
  }

  onError(cb: ErrorCallback): void {
    this.errorCb = cb
  }

  finish(): Promise<void> {
    if (this.closed || this.finishing) return Promise.resolve()
    this.finishing = true
    return new Promise<void>((resolve) => {
      this.finishResolve = resolve
      this.finishTimer = setTimeout(() => this.completeFinish(), FLUSH_TIMEOUT_MS)

      const ws = this.ws
      if (ws?.readyState === WebSocket.OPEN) {
        // Mid-stream stop: flush is already done. Ask for trailing finals, or
        // complete now if the server has nothing left to finalize.
        if (!this.requestFinalize()) this.completeFinish()
      } else if (ws?.readyState !== WebSocket.CONNECTING) {
        // No live socket to flush through — nothing to wait for.
        this.completeFinish()
      }
      // CONNECTING: onopen flushes the buffer then finalizes.
    })
  }

  finalize(): void {
    if (this.closed || this.finishing || this.ws?.readyState !== WebSocket.OPEN) return
    this.requestMidStreamFinalize()
  }

  close(): void {
    // finish() already sent the finalize message; don't send it twice.
    if (!this.closed && !this.finishing && this.ws?.readyState === WebSocket.OPEN) {
      this.requestFinalize()
    }
    // Unblock a finish() still awaiting trailing transcripts, if any.
    if (this.finishResolve) this.completeFinish()
    else this.hardClose()
  }

  /** Resolve a pending finish() exactly once, then tear down the socket. */
  protected completeFinish(): void {
    if (this.finishResolve === null) return
    const resolve = this.finishResolve
    this.finishResolve = null
    if (this.finishTimer !== null) {
      clearTimeout(this.finishTimer)
      this.finishTimer = null
    }
    this.hardClose()
    resolve()
  }

  private hardClose(): void {
    this.closed = true
    this.pendingAudio = []
    this.pendingBytes = 0
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  protected emitTranscript(event: TranscriptEvent): void {
    if (event.type === 'interim') this.stats.interims++
    else if (event.type === 'final') this.stats.finals++
    this.transcriptCb?.(event)
  }

  protected emitError(error: Error): void {
    this.noteError(error)
    this.stats.errors++
    this.errorCb?.(error)
  }
}

// --- Deepgram Adapter ---

const DEEPGRAM_WS_PARAMS = new URLSearchParams({
  model: 'nova-3',
  interim_results: 'true',
  smart_format: 'true',
  endpointing: '300',
  vad_events: 'true',
  utterance_end_ms: '1000',
  encoding: 'linear16',
  sample_rate: '16000',
  channels: '1',
})

class DeepgramAdapter extends WebSocketSttAdapter {
  protected readonly connectErrorLabel = 'Deepgram'
  protected readonly closeErrorLabel = 'Deepgram'

  protected createSocket(token: string): WebSocket {
    const url = `wss://api.deepgram.com/v1/listen?${DEEPGRAM_WS_PARAMS.toString()}`
    return new WebSocket(url, ['bearer', token])
  }

  protected writeAudio(chunk: ArrayBuffer): void {
    this.ws?.send(chunk)
  }

  protected requestFinalize(): boolean {
    // CloseStream is safe even with no buffered audio — Deepgram just closes.
    this.ws?.send(JSON.stringify({ type: 'CloseStream' }))
    return true
  }

  protected requestMidStreamFinalize(): void {
    // Answered by a Results message flagged from_finalize (empty when nothing
    // was pending); the stream stays open.
    this.ws?.send(JSON.stringify({ type: 'Finalize' }))
  }

  protected handleMessage(data: any): void {
    if (data.type === 'Results') {
      const alt = data.channel?.alternatives?.[0]
      const text = alt?.transcript || ''
      if (text) this.emitTranscript({ type: data.speech_final || data.is_final ? 'final' : 'interim', text })
      if (data.from_finalize) this.emitTranscript({ type: 'finalized', text: '' })
    } else if (data.type === 'SpeechStarted') {
      // Voice activity, ahead of any words: the earliest sign the person is talking.
      this.emitTranscript({ type: 'speech_started', text: '' })
    } else if (data.type === 'UtteranceEnd') {
      this.emitTranscript({ type: 'speech_ended', text: '' })
    }
  }
}

// --- OpenAI Adapter ---

/** Map OpenAI Realtime error objects to user-friendly messages. */
function friendlyRealtimeError(err: { code?: string; message?: string } | undefined): Error {
  const code = err?.code || ''
  const msg = err?.message || 'OpenAI Realtime error'
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached' ||
      code === 'rate_limit_exceeded' || /quota|billing|insufficient/i.test(msg)) {
    return new Error('OpenAI API quota exceeded. Please check your OpenAI account balance and billing settings.')
  }
  return new Error(msg)
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

class OpenaiAdapter extends WebSocketSttAdapter {
  readonly sampleRate = 24000
  protected readonly connectErrorLabel = 'OpenAI Realtime'
  protected readonly closeErrorLabel = 'OpenAI'
  private pendingDelta = ''
  // Tracks audio appended but not yet committed. With server_vad the server
  // auto-commits each utterance, so a manual commit with nothing pending fails
  // with "buffer too small" — only commit when there's actually audio to flush.
  private hasUncommittedAudio = false
  // A finalize() is waiting for the transcript of the buffer it committed.
  private finalizePending = false

  protected createSocket(token: string): WebSocket {
    const url = 'wss://api.openai.com/v1/realtime?intent=transcription'
    return new WebSocket(url, ['realtime', `openai-insecure-api-key.${token}`])
  }

  protected onConnected(): void {
    this.ws?.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            noise_reduction: { type: 'near_field' },
            transcription: {
              model: 'gpt-4o-mini-transcribe',
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              silence_duration_ms: 500,
              prefix_padding_ms: 300,
            },
          },
        },
      },
    }))
  }

  protected writeAudio(chunk: ArrayBuffer): void {
    this.ws?.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: arrayBufferToBase64(chunk),
    }))
    this.hasUncommittedAudio = true
  }

  protected requestFinalize(): boolean {
    // Nothing to commit (server_vad already committed it) — committing now would
    // fail with "buffer too small". Skip and let finish() complete immediately.
    if (!this.hasUncommittedAudio) return false
    this.ws?.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    this.hasUncommittedAudio = false
    return true
  }

  protected requestMidStreamFinalize(): void {
    // Same empty-buffer hazard as requestFinalize: with nothing to commit the
    // utterance is already final, so answer right away.
    if (!this.hasUncommittedAudio) {
      this.emitTranscript({ type: 'finalized', text: '' })
      return
    }
    this.finalizePending = true
    this.ws?.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    this.hasUncommittedAudio = false
  }

  protected handleMessage(data: any): void {
    switch (data.type) {
      case 'conversation.item.input_audio_transcription.delta':
        if (data.delta) {
          // Accumulate deltas so interim events carry the full text so far
          this.pendingDelta += data.delta
          this.emitTranscript({ type: 'interim', text: this.pendingDelta })
        }
        break
      case 'conversation.item.input_audio_transcription.completed':
        this.pendingDelta = ''
        if (data.transcript) {
          this.emitTranscript({ type: 'final', text: data.transcript })
        }
        if (this.finalizePending) {
          this.finalizePending = false
          this.emitTranscript({ type: 'finalized', text: '' })
        }
        // The committed utterance's transcript is in — complete a pending finish()
        // (no-op during normal streaming, when nothing is awaiting).
        this.completeFinish()
        break
      case 'input_audio_buffer.committed':
        // Server committed the buffer (server_vad) — nothing left to flush.
        this.hasUncommittedAudio = false
        break
      case 'input_audio_buffer.speech_started':
        this.emitTranscript({ type: 'speech_started', text: '' })
        break
      case 'input_audio_buffer.speech_stopped':
        this.emitTranscript({ type: 'speech_ended', text: '' })
        break
      case 'conversation.item.input_audio_transcription.failed':
        // The server heard the utterance but could not transcribe it (a model
        // the project may not use, a quota). Without this the words just vanish.
        this.emitError(friendlyRealtimeError(data.error))
        if (this.isFinishing) this.completeFinish()
        break
      case 'error':
        // A late error while wrapping up (e.g. an empty-buffer commit that raced
        // the server's auto-commit) is benign — finish quietly instead of alarming
        // the user, who already has their transcript.
        if (this.isFinishing) {
          this.noteError(friendlyRealtimeError(data.error))
          this.completeFinish()
        } else {
          this.emitError(friendlyRealtimeError(data.error))
        }
        break
      case 'response.done':
        if (data.response?.status === 'failed') {
          this.emitError(friendlyRealtimeError(data.response?.status_details?.error))
        }
        break
    }
  }
}

// --- Factory ---

export function createSttAdapter(provider: VoiceProvider): SttAdapter {
  switch (provider) {
    case 'deepgram':
    case 'platform':
      return new DeepgramAdapter()
    case 'openai':
      return new OpenaiAdapter()
    default:
      throw new Error(`Unknown voice provider: ${provider}`)
  }
}

// --- Shared audio capture ---

/** Convert Float32 audio samples [-1, 1] to Int16 PCM */
export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
  }
  return int16
}

/** Convert Int16 PCM audio to Float32 samples [-1, 1] for Web Audio playback */
export function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const int16 = new Int16Array(buffer)
  const float32 = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 0x8000
  }
  return float32
}

/** Where captured audio goes: an STT or voice-agent adapter. */
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
 * Set up microphone capture and pipe 16-bit PCM chunks to `sink` (an STT or
 * voice-agent adapter), at the sink's sample rate (16 kHz unless it says
 * otherwise). Returns handles for the resources and a cleanup function. The
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
