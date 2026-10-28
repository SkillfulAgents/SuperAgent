export type TtsEvent =
  /** The server finished sending audio for everything queued before the k-th flush(). */
  | { type: 'flushed'; sequenceId: number }
  /** The server dropped its queued text/audio in response to clear(). */
  | { type: 'cleared'; sequenceId: number }
  /** The server closed the connection cleanly, unasked. Nothing more will arrive. */
  | { type: 'closed' }
  | { type: 'error'; error: Error }

export interface TtsVoiceOptions {
  /** Provider voice id. */
  voice: string
  /** Speaking-rate multiplier; 1 is the provider's natural pace. */
  speed?: number
}

export type TtsAudioCallback = (chunk: ArrayBuffer) => void
export type TtsEventCallback = (event: TtsEvent) => void

/**
 * Streaming text-to-speech session: text goes in as it becomes available,
 * PCM audio comes back. The mirror image of SttAdapter.
 *
 * Text is buffered until the transport is initialized, so callers can queue and flush
 * immediately after connect() without awaiting it.
 */
export interface TtsAdapter {
  /** Sample rate of the returned int16 mono PCM. */
  readonly sampleRate: number
  connect(options: TtsVoiceOptions): Promise<void>
  /** Queue text for synthesis. May be called repeatedly with partial text. */
  speak(text: string): void
  /**
   * Ask the server to synthesize everything queued so far. A 'flushed' event
   * follows the last audio chunk of that batch, which is how callers learn
   * where one batch's audio ends and the next begins.
   */
  flush(): void
  /** Drop queued text and any audio not yet delivered. */
  clear(): void
  onAudio(cb: TtsAudioCallback): void
  onEvent(cb: TtsEventCallback): void
  close(): void
}
