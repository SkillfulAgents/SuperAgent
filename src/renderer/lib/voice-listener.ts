import { apiFetch } from '@renderer/lib/api'
import {
  acquireMicStream,
  createSttAdapter,
  startAudioCapture,
  type AudioCaptureHandle,
  type SttAdapter,
  type VoiceProvider,
} from '@renderer/lib/stt'

export interface VoiceListenerEvents {
  /** The utterance heard so far (finals plus the interim tail), on every change. */
  onUtterance: (text: string) => void
  /** The server's voice activity detection: the person started talking (before any words are in). */
  onSpeechStarted?: () => void
  /** The server's silence detection: the person stopped talking. */
  onSpeechEnded: () => void
  /** The connection is gone for good (after a reconnect attempt failed). */
  onError: (error: Error) => void
}

/** How long take() waits for the server's finals before using what it has. */
const FINALIZE_TIMEOUT_MS = 1_200
/**
 * One transparent reconnect after a dropped socket; a second drop before
 * the new socket has carried any words is an error. A socket that did
 * carry words earns the next drop its own reconnect.
 */
const MAX_RECONNECTS = 1

interface SttCredentials {
  provider: VoiceProvider
  token: string
}

/**
 * A microphone that stays open. Unlike the composer's dictation (one
 * recording per press, closed on submit), voice mode listens continuously:
 * the transcript accumulates into one utterance at a time, and `take()`
 * hands the current utterance over and starts the next one on the same
 * connection — with the server asked to finalize first, so the words spoken
 * right before the take are not lost or repeated into the next utterance.
 *
 * Lives outside React so the hook that drives voice mode can read the
 * utterance and its word count without re-rendering on every interim.
 */
export class VoiceListener {
  private adapter: SttAdapter | null = null
  private capture: AudioCaptureHandle | null = null
  private stream: MediaStream | null = null
  private finalized = ''
  private interim = ''
  private running = false
  private reconnects = 0
  /** A take() waiting for the server's finals. */
  private pendingTake: { resolve: () => void; timer: ReturnType<typeof setTimeout> } | null = null
  // Bumped by stop(), so an in-flight start() that resolves afterwards
  // releases what it acquired instead of resurrecting the listener.
  private generation = 0

  constructor(private readonly events: VoiceListenerEvents) {}

  /** The mic's analyser, for the level meter. Null until capture is up. */
  get analyser(): AnalyserNode | null {
    return this.capture?.analyser ?? null
  }

  get isRunning(): boolean {
    return this.running
  }

  /** What has been heard since the last take(): finals plus the interim tail. */
  get utterance(): string {
    return joinUtterance(this.finalized, this.interim)
  }

  get wordCount(): number {
    const text = this.utterance.trim()
    return text ? text.split(/\s+/).length : 0
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const generation = ++this.generation
    // Permission and hardware spin-up run alongside the token round-trip.
    const streamPromise = acquireMicStream()
    streamPromise.catch(() => {})
    try {
      const adapter = await this.connect()
      if (generation !== this.generation) {
        adapter.close()
        streamPromise.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {})
        return
      }
      // Owned from here on, so a handshake failure while the mic is still
      // being acquired reaches recover() instead of going unnoticed.
      this.adapter = adapter
      const stream = await streamPromise
      if (generation !== this.generation) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      this.stream = stream
      const capture = await startAudioCapture(adapter, stream, { withAnalyser: true })
      if (generation !== this.generation) {
        capture.cleanup()
        return
      }
      this.capture = capture
    } catch (err) {
      streamPromise.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {})
      if (generation === this.generation) this.stop()
      throw err instanceof Error ? err : new Error('Failed to start listening')
    }
  }

  stop(): void {
    this.generation++
    this.running = false
    this.settleTake()
    this.capture?.cleanup()
    this.capture = null
    this.stream = null
    this.adapter?.close()
    this.adapter = null
    this.finalized = ''
    this.interim = ''
  }

  /**
   * Hand over the current utterance and start a fresh one. Asks the server
   * to finalize what it has heard so the tail of the utterance is included,
   * bounded by FINALIZE_TIMEOUT_MS.
   */
  async take(): Promise<string> {
    const adapter = this.adapter
    if (adapter && !this.pendingTake) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => this.settleTake(), FINALIZE_TIMEOUT_MS)
        this.pendingTake = { resolve, timer }
        adapter.finalize()
      })
    } else if (this.pendingTake) {
      // A second take while one is waiting shares its finalize.
      await new Promise<void>((resolve) => {
        const previous = this.pendingTake!
        this.pendingTake = {
          timer: previous.timer,
          resolve: () => {
            previous.resolve()
            resolve()
          },
        }
      })
    }
    const text = this.utterance.trim()
    this.finalized = ''
    this.interim = ''
    this.events.onUtterance('')
    return text
  }

  /** Drop what was heard since the last take (noise while the agent spoke). */
  async discard(): Promise<void> {
    await this.take()
  }

  private async connect(): Promise<SttAdapter> {
    const res = await apiFetch('/api/voice/token')
    const data: SttCredentials | { error: string } = await res.json()
    if (!res.ok) throw new Error(('error' in data ? data.error : null) || 'Failed to get speech-to-text credentials')
    const { provider, token } = data as SttCredentials
    const adapter = createSttAdapter(provider)
    adapter.onTranscript((event) => {
      if (this.adapter !== adapter) return
      // Words through a reconnected socket: the connection is good again.
      if (this.reconnects > 0 && (event.type === 'interim' || event.type === 'final')) this.reconnects = 0
      switch (event.type) {
        case 'interim':
          this.interim = event.text
          this.events.onUtterance(this.utterance)
          break
        case 'final':
          this.finalized = joinUtterance(this.finalized, event.text)
          this.interim = ''
          this.events.onUtterance(this.utterance)
          break
        case 'finalized':
          this.settleTake()
          break
        case 'speech_started':
          this.events.onSpeechStarted?.()
          break
        case 'speech_ended':
          this.events.onSpeechEnded()
          break
      }
    })
    adapter.onError((err) => {
      if (this.adapter !== adapter) return
      void this.recover(err)
    })
    // The adapter buffers audio sent before the socket opens, so capture
    // starts while the handshake is in flight.
    adapter.connect(token).catch((err: unknown) => {
      if (this.adapter !== adapter) return
      void this.recover(err instanceof Error ? err : new Error('Failed to connect'))
    })
    return adapter
  }

  /**
   * The socket dropped mid-session (a token past its life, a network blip):
   * open a new one on the same mic. Words in flight are lost, the utterance
   * so far is kept.
   */
  private async recover(cause: Error): Promise<void> {
    const generation = this.generation
    this.adapter?.close()
    this.adapter = null
    this.settleTake()
    if (!this.running || this.reconnects >= MAX_RECONNECTS) {
      this.stop()
      this.events.onError(cause)
      return
    }
    this.reconnects++
    try {
      const adapter = await this.connect()
      if (generation !== this.generation) {
        adapter.close()
        return
      }
      this.adapter = adapter
      // Re-point the running capture at the new adapter.
      this.capture?.setSink(adapter)
    } catch (err) {
      if (generation !== this.generation) return
      this.stop()
      this.events.onError(err instanceof Error ? err : cause)
    }
  }

  private settleTake(): void {
    const pending = this.pendingTake
    if (!pending) return
    this.pendingTake = null
    clearTimeout(pending.timer)
    pending.resolve()
  }
}

function joinUtterance(head: string, tail: string): string {
  if (!head) return tail
  if (!tail) return head
  return `${head} ${tail}`
}
