import { apiFetch } from '@renderer/lib/api'
import { acquireMicStream } from '../../shared/audio-capture'
import { OpenAILiveBridge } from './live-bridge'
import type { LiveRequest, LiveSessionAnswer, VoiceHistory, VoiceTranscriptEntry } from '@shared/lib/voice/live-types'

interface ConversationEvents {
  onRequest: (request: LiveRequest) => Promise<boolean>
  onUtterance: (text: string) => void
  onTranscript?: (entries: VoiceTranscriptEntry[]) => void
  onSpeaking: (speaking: boolean) => void
  onInputSpeaking?: (speaking: boolean) => void
  onReady: () => void
  onClosed?: () => void
  onError: (message: string) => void
}

// Keep the speaking state through breaths and sentence gaps. Audio samples,
// not transcript arrival, tell us whether the remote voice is being played.
export const LIVE_SPEECH_RELEASE_MS = 1200
export const LIVE_DISCONNECT_GRACE_MS = 8000
const AUDIO_METER_MS = 20
const OUTPUT_SPEECH_RMS = 0.003
// Only extends speech already confirmed by transcription; never opens the gate.
const INPUT_SPEECH_RMS = 0.006

function sampleRms(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer)
  let energy = 0
  for (let i = 0; i < buffer.length; i++) energy += buffer[i] * buffer[i]
  return Math.sqrt(energy / buffer.length)
}

/** WebRTC media and the Live protocol belong to the OpenAI implementation. */
export class OpenAILiveConversation {
  private peer: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private microphone: MediaStream | null = null
  private audio: HTMLAudioElement | null = null
  private context: AudioContext | null = null
  analyser: AnalyserNode | null = null
  private outputAnalyser: AnalyserNode | null = null
  private meter: ReturnType<typeof setInterval> | undefined
  private inputSpeechTimer: ReturnType<typeof setInterval> | undefined
  private lastInputActivity = -Infinity
  private inputSpeaking = false
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined
  private expiryWarningTimer: ReturnType<typeof setTimeout> | undefined
  private readonly onPageHide = () => { this.close(); this.cleanup() }
  private closingTimer: ReturnType<typeof setTimeout> | undefined
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private ready = false
  private closed = false
  private paused = false
  private commands: Record<string, unknown>[] = []
  private sessionId: string | null = null
  private bridge: OpenAILiveBridge
  private replyText = ''
  private replyFed = 0
  private replyTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private events: ConversationEvents, private history: VoiceHistory = []) {
    this.bridge = new OpenAILiveBridge({
      ...events,
      onInputTranscript: (delta) => this.detectInputWords(delta),
      send: (event) => this.send(event),
      map: async (input, signal) => {
        const res = await apiFetch('/api/voice/live/map', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error || `Voice mapping failed (${res.status}).`)
        if (!data) throw new Error('Voice mapping returned an invalid response.')
        return data
      },
    }, history)
  }

  async start() {
    if (this.closed) return
    window.addEventListener('pagehide', this.onPageHide)
    try {
      const peer = new RTCPeerConnection()
      this.peer = peer
      const audio = new Audio()
      audio.autoplay = true
      this.audio = audio
      this.context = new AudioContext()
      await this.context.resume()
      if (this.closed) return
      const microphone = await acquireMicStream()
      if (this.closed) { microphone.getTracks().forEach((track) => track.stop()); return }
      this.microphone = microphone
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = 2048
      this.context.createMediaStreamSource(microphone).connect(this.analyser)
      // Input transcripts open the music-suppression gate. Microphone activity
      // may only keep an already-open gate alive while transcription catches up.
      for (const track of microphone.getAudioTracks()) {
        track.enabled = !this.paused
        peer.addTrack(track, microphone)
      }
      peer.ontrack = ({ track }) => {
        if (this.closed) return
        const stream = new MediaStream([track])
        audio.srcObject = stream
        audio.muted = this.paused
        void audio.play().catch(() => this.events.onError('Audio playback was blocked. Press the microphone to enable it.'))
        this.outputAnalyser = this.context!.createAnalyser()
        this.outputAnalyser.fftSize = 2048
        this.context!.createMediaStreamSource(stream).connect(this.outputAnalyser)
        clearInterval(this.meter)
        this.meter = this.monitorSpeech(this.outputAnalyser, OUTPUT_SPEECH_RMS, (speaking) => {
          // Publish playback first so clearing input never briefly allows music.
          this.events.onSpeaking(speaking)
          if (speaking) this.clearInputSpeech()
        })
      }
      peer.onconnectionstatechange = () => {
        if (this.closed) return
        if (peer.connectionState === 'failed') {
          this.fail('Voice connection lost. Exit voice mode and re-enter to reconnect.')
        } else if (peer.connectionState === 'disconnected') {
          if (this.disconnectTimer === undefined) this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = undefined
            if (peer.connectionState !== 'connected') this.fail('Voice connection lost. Exit voice mode and re-enter to reconnect.')
          }, LIVE_DISCONNECT_GRACE_MS)
        } else if (peer.connectionState === 'connected') {
          clearTimeout(this.disconnectTimer)
          this.disconnectTimer = undefined
        }
      }
      const channel = peer.createDataChannel('oai-events')
      this.channel = channel
      channel.onmessage = ({ data }) => {
        let event: Record<string, unknown>
        try { event = JSON.parse(data) } catch { return }
        if (event.type === 'session.closed') {
          if (!this.closed) this.events.onError('The voice session ended. Re-enter voice mode to reconnect.')
          this.close()
          this.cleanup()
          return
        }
        if (this.closed) return
        if (event.type === 'session.started') {
          clearTimeout(this.startupTimer)
          this.ready = true
          for (const command of this.commands.splice(0)) this.send(command)
          this.setPaused(this.paused)
          this.events.onReady()
        } else if (event.type === 'error') {
          this.events.onError((event.error as { message?: string })?.message || 'OpenAI Live error.')
        } else this.bridge.receive(event)
      }
      channel.onclose = () => { if (!this.closed) this.fail('Voice connection closed. Re-enter voice mode to reconnect.') }
      const offer = await peer.createOffer()
      if (this.closed) return
      await peer.setLocalDescription(offer)
      await this.gatherIce(peer)
      if (this.closed) return
      const sdp = peer.localDescription?.sdp
      if (!sdp) throw new Error('Could not create a microphone connection.')
      // Let creation finish even if stopped: the returned handle can then be
      // closed on the host, including when WebRTC never reached session.started.
      const res = await apiFetch('/api/voice/live/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp, history: this.history }),
      })
      const answer = await res.json().catch(() => null) as (LiveSessionAnswer & { error?: string; handle: string; expiresAt?: number }) | null
      if (!res.ok) throw new Error(answer?.error || `Could not connect OpenAI Live (${res.status}).`)
      if (!answer?.handle || !answer.transport?.sdp) throw new Error('OpenAI Live returned an invalid session answer.')
      this.sessionId = answer.handle
      if (this.closed) { this.releaseSession(); return }
      if (answer.expiresAt) this.expiryWarningTimer = setTimeout(() => {
        this.events.onError('This voice connection expires in one minute. Exit and re-enter voice mode to continue; your agent work will keep running.')
      }, Math.max(0, answer.expiresAt - Date.now() - 60_000))
      this.startupTimer = setTimeout(() => this.fail('OpenAI Live did not start. Re-enter voice mode to retry.'), 15_000)
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.transport.sdp })
    } catch (error) {
      if (!this.closed) this.fail(error instanceof Error ? error.message : 'Could not start voice mode.')
    }
  }

  private detectInputWords(delta: string) {
    // Use fresh subtitle fragments, not the accumulated utterance: resets and
    // punctuation must not reopen or extend the speech window.
    if (this.closed || this.paused || !/[\p{L}\p{N}]/u.test(delta)) return
    this.lastInputActivity = Date.now()
    if (this.inputSpeaking) return
    this.inputSpeaking = true
    this.events.onInputSpeaking?.(true)
    const analyser = this.analyser
    const buffer = analyser ? new Float32Array(analyser.fftSize) : null
    this.inputSpeechTimer = setInterval(() => {
      if (analyser && buffer) {
        const rms = sampleRms(analyser, buffer)
        if (rms > INPUT_SPEECH_RMS) this.lastInputActivity = Date.now()
      }
      if (Date.now() - this.lastInputActivity >= LIVE_SPEECH_RELEASE_MS) this.clearInputSpeech()
    }, AUDIO_METER_MS)
  }

  private clearInputSpeech() {
    clearInterval(this.inputSpeechTimer)
    this.inputSpeechTimer = undefined
    this.lastInputActivity = -Infinity
    if (this.inputSpeaking) {
      this.inputSpeaking = false
      this.events.onInputSpeaking?.(false)
    }
  }

  private monitorSpeech(analyser: AnalyserNode, threshold: number, onChange: (speaking: boolean) => void) {
    const buffer = new Float32Array(analyser.fftSize)
    let lastSound = -Infinity
    let speaking = false
    return setInterval(() => {
      const rms = sampleRms(analyser, buffer)
      if (!this.paused && rms > threshold) lastSound = Date.now()
      if (this.paused) lastSound = -Infinity
      const next = !this.paused && Date.now() - lastSound < LIVE_SPEECH_RELEASE_MS
      if (next !== speaking) { speaking = next; onChange(next) }
    }, AUDIO_METER_MS)
  }

  private gatherIce(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer)
        peer.removeEventListener('icegatheringstatechange', changed)
        if (peer.iceGatheringState === 'complete') resolve()
        else reject(new Error('Microphone connection timed out.'))
      }
      const changed = () => { if (peer.iceGatheringState === 'complete') finish() }
      const timer = setTimeout(finish, 10_000)
      peer.addEventListener('icegatheringstatechange', changed)
      changed()
    })
  }

  setPaused(paused: boolean) {
    this.paused = paused
    if (paused) this.clearInputSpeech()
    this.bridge.setPaused(paused)
    this.microphone?.getTracks().forEach((track) => { track.enabled = !paused })
    if (this.audio) this.audio.muted = paused
    this.send({ type: paused ? 'session.input_audio.mute' : 'session.input_audio.unmute' })
    this.send({ type: 'session.instructions.append', delegation_id: null, content: paused
      ? 'The user is answering a request card in the application. Wait silently; do not delegate until the application resumes.'
      : 'The application is ready for voice conversation. Continue listening and responding normally.' })
  }

  setBusy(busy: boolean) { this.bridge.setBusy(busy) }

  resetReply() {
    this.bridge.invalidateReplies()
    clearTimeout(this.replyTimer)
    this.replyText = ''
    this.replyFed = 0
  }

  /** Receives the same cumulative text stream used by Deepgram read-aloud. */
  updateReply(text: string, complete = false) {
    if (this.closed) return
    this.replyText = text
    clearTimeout(this.replyTimer)
    if (complete || text.length - this.replyFed >= 1200) this.flushReply()
    else this.replyTimer = setTimeout(() => this.flushReply(), 1000)
  }

  /** The shared coordinator supplies message boundaries; no text-prefix guessing here. */
  nextReplySegment() {
    clearTimeout(this.replyTimer)
    this.flushReply()
    this.replyText = ''
    this.replyFed = 0
  }

  private flushReply() {
    const text = this.replyText.slice(this.replyFed)
    this.replyFed = this.replyText.length
    // Bound each summarizer request without silently dropping long segments.
    for (let start = 0; start < text.length; start += 12000) this.bridge.reply(text.slice(start, start + 12000))
  }

  pressMic(busy: boolean) {
    void this.context?.resume()
    void this.audio?.play().catch(() => this.events.onError('Audio playback is still blocked.'))
    if (busy) {
      this.send({ type: 'session.instructions.append', delegation_id: null, content: 'Stop speaking now and listen to the user. Do not cancel backend work just because speech stopped.' })
    } else this.bridge.requestNow()
  }

  private send(event: Record<string, unknown>) {
    if (this.closed) return
    if (this.ready && this.channel?.readyState === 'open') this.channel.send(JSON.stringify(event))
    else if (this.commands.length < 128) this.commands.push(event)
  }

  private fail(message: string) { this.events.onError(message); this.close() }

  close() {
    if (this.closed) return
    this.closed = true
    window.removeEventListener('pagehide', this.onPageHide)
    clearTimeout(this.disconnectTimer)
    clearTimeout(this.expiryWarningTimer)
    this.events.onSpeaking(false)
    this.clearInputSpeech()
    this.bridge.close()
    clearTimeout(this.startupTimer)
    clearTimeout(this.replyTimer)
    clearInterval(this.meter)
    clearInterval(this.inputSpeechTimer)
    this.microphone?.getTracks().forEach((track) => track.stop())
    if (this.audio) this.audio.muted = true
    this.events.onClosed?.()
    if (this.ready && this.channel?.readyState === 'open') {
      this.channel.send(JSON.stringify({ type: 'session.close' }))
      this.closingTimer = setTimeout(() => { this.releaseSession(); this.cleanup() }, 1500)
    } else { this.releaseSession(); this.cleanup() }
  }

  private releaseSession() {
    if (!this.sessionId) return
    const id = this.sessionId
    this.sessionId = null
    void apiFetch(`/api/voice/live/session/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }).catch(() => {})
  }

  private cleanup() {
    clearTimeout(this.closingTimer)
    clearInterval(this.meter)
    clearInterval(this.inputSpeechTimer)
    this.releaseSession()
    this.microphone?.getTracks().forEach((track) => track.stop())
    this.channel?.close()
    this.peer?.close()
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null }
    void this.context?.close().catch(() => {})
    this.analyser = null
  }
}
