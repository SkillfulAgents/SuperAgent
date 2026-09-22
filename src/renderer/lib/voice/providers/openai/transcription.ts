import { WebSocketSttAdapter } from '../../shared/websocket-stt'
import { arrayBufferToBase64 } from '../../shared/pcm'
import { friendlyRealtimeError } from './errors'

export class OpenAISttAdapter extends WebSocketSttAdapter {
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

  constructor(private readonly quotaExceeded: string) {
    super()
  }

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
        this.emitError(new Error(friendlyRealtimeError(data.error, this.quotaExceeded)))
        if (this.isFinishing) this.completeFinish()
        break
      case 'error':
        // A late error while wrapping up (e.g. an empty-buffer commit that raced
        // the server's auto-commit) is benign — finish quietly instead of alarming
        // the user, who already has their transcript.
        if (this.isFinishing) {
          this.noteError(new Error(friendlyRealtimeError(data.error, this.quotaExceeded)))
          this.completeFinish()
        } else {
          this.emitError(new Error(friendlyRealtimeError(data.error, this.quotaExceeded)))
        }
        break
      case 'response.done':
        if (data.response?.status === 'failed') {
          this.emitError(new Error(friendlyRealtimeError(data.response?.status_details?.error, this.quotaExceeded)))
        }
        break
    }
  }
}
