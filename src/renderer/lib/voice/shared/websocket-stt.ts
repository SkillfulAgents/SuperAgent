import type { SttAdapter, SttSessionStats, TranscriptCallback, ErrorCallback, TranscriptEvent } from '../contracts/stt'

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

/**
 * Shared WebSocket lifecycle for the STT adapters: pre-open audio buffering,
 * deliberate-close error suppression, and graceful finish() (flush buffered
 * audio + await the server's trailing transcripts). Subclasses supply only the
 * provider-specific bits — how to open the socket, configure the session, write
 * a chunk, finalize, and parse incoming messages.
 */
export abstract class WebSocketSttAdapter implements SttAdapter {
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
