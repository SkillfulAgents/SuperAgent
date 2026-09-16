export type { VoiceProvider } from '@shared/lib/config/settings'

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
