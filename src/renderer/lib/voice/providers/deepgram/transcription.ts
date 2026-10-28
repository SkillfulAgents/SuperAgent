import { WebSocketSttAdapter } from '../../shared/websocket-stt'

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

export class DeepgramSttAdapter extends WebSocketSttAdapter {
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
