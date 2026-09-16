import { readAloud, voiceStreamId } from '../services/read-aloud'
import { VoiceListener } from '../services/listener'
import type { VoiceAgentEvent, VoiceAgentState, VoiceConversationAdapter, VoiceConversationContext, VoiceConversationEvents, VoiceTurnPolicy } from '../contracts/conversation'

export const INTERRUPT_WORD_THRESHOLD = 4
export const DUCK_MAX_MS = 4_000
export const LISTENER_RESTART_MS = 1_000
const LISTENER_RESTART_MAX_MS = 15_000
const KEEP_RECENT_WORDS_MS = 2_500
/**
 * Read-aloud plays decoded PCM with its own level hold, so it reports
 * silence only at real gaps. A short release keeps hold music prompt
 * between sentences; Live needs a longer one for a remote voice's breaths.
 */
export const PLAYBACK_RELEASE_MS = 300
/** The bounds chained speech has always used, plus its send-anyway contract. */
export const CHAINED_TURN_POLICY: VoiceTurnPolicy = {
  interruptTimeoutMs: 5_000,
  turnStartTimeoutMs: 8_000,
  sendAfterFailedInterrupt: true,
}

/** Chained STT + read-aloud. Agent execution is supplied through onCommand. */
export class ChainedConversationAdapter implements VoiceConversationAdapter {
  readonly capabilities = { speechSpeed: true, spokenTranscript: false }
  readonly turnPolicy = CHAINED_TURN_POLICY
  // Words taken from the mic as a request card went up: sent once it is answered.
  private held: string | null = null
  private readonly streamId: string
  private listener: VoiceListener | null = null
  private unsubscribe: (() => void) | null = null
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private duckTimer: ReturnType<typeof setTimeout> | undefined
  private restarts = 0
  private closed = false
  private paused = false
  private ready = false
  private assistantSpeaking = false
  private lastAudioAt = -Infinity
  private audioMeter: ReturnType<typeof setInterval> | undefined
  private sending = false
  private userTurn = true
  private userSpeaking = false
  private utterance = ''
  private burstStart = 0
  private lastHeardAt = 0
  private readerStarted = false
  private segment: number | null = null
  private state: VoiceAgentState = { active: false, awaiting: false, toolsUsed: false }

  constructor(context: VoiceConversationContext, private events: VoiceConversationEvents) {
    this.streamId = voiceStreamId(context.sessionId)
  }

  get analyser() { return this.listener?.analyser ?? null }

  async start() {
    if (this.closed) return
    this.unsubscribe = readAloud.subscribe(() => {
      if (this.closed) return
      const snapshot = readAloud.getSnapshot()
      if (snapshot.errorId === this.streamId && snapshot.error) this.events.onError(snapshot.error)
      this.samplePlayback()
      this.settleTurn()
      this.publish()
    })
    this.audioMeter = setInterval(() => { if (this.samplePlayback()) this.publish() }, 20)
    this.publish()
    await this.openListener()
  }

  private async openListener() {
    if (this.closed || this.paused) return
    const listener = new VoiceListener({
      onUtterance: (text) => {
        if (this.listener !== listener) return
        this.utterance = text
        if (text.trim()) this.lastHeardAt = Date.now()
        const words = listener.wordCount
        if (!this.userTurn && words - Math.min(this.burstStart, words) >= INTERRUPT_WORD_THRESHOLD) this.interrupt()
        this.publish()
      },
      onSpeechStarted: () => {
        if (this.listener !== listener) return
        this.userSpeaking = true
        this.burstStart = listener.wordCount
        if (!this.userTurn) readAloud.duckStream(this.streamId, true)
        clearTimeout(this.duckTimer)
        // A cough may have no transcript and consequently no speech-end event.
        this.duckTimer = setTimeout(() => { this.userSpeaking = false; this.unduck(); this.publish() }, DUCK_MAX_MS)
        this.publish()
      },
      onSpeechEnded: () => {
        if (this.listener !== listener) return
        this.userSpeaking = false
        this.unduck()
        if (this.userTurn && listener.utterance.trim()) void this.sendUtterance()
        this.publish()
      },
      onError: (error) => {
        if (this.listener !== listener) return
        this.ready = false
        this.events.onError(error.message)
        this.scheduleRestart()
        this.publish()
      },
    })
    this.listener = listener
    try {
      await listener.start()
      if (this.listener !== listener || this.closed) return
      this.ready = true
      this.restarts = 0
      this.events.onError(null)
      this.publish()
    } catch (error) {
      if (this.listener !== listener || this.closed) return
      this.events.onError(error instanceof Error ? error.message : 'Failed to start listening')
      this.scheduleRestart()
    }
  }

  private scheduleRestart() {
    if (this.restartTimer || this.closed || this.paused) return
    const delay = Math.min(LISTENER_RESTART_MAX_MS, LISTENER_RESTART_MS * 2 ** this.restarts++)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.stopListener()
      void this.openListener()
    }, delay)
  }

  private unduck() {
    clearTimeout(this.duckTimer)
    readAloud.duckStream(this.streamId, false)
  }

  private interrupt() {
    this.userTurn = true
    this.stopReader()
    this.unduck()
    void this.events.onCommand({ type: 'cancel' })
    this.publish()
  }

  private async sendUtterance() {
    const listener = this.listener
    if (!listener || this.sending) return
    this.sending = true
    try {
      const text = await listener.take()
      if (!text || this.closed) return
      // A card went up while the mic was finalizing: the words are kept for
      // when it is answered, not thrown away. A mic that was merely reopened
      // meanwhile changes nothing about what was said.
      if (this.paused) { this.held = text; return }
      await this.submit(text)
    } finally { this.sending = false }
  }

  private async submit(text: string) {
    this.userTurn = false
    const result = await this.events.onCommand({ type: 'submit', text })
    if (this.closed) return
    if (!result.accepted) this.userTurn = true
    this.publish()
  }

  acceptAgentEvent(event: VoiceAgentEvent) {
    if (this.closed) return
    if (event.type === 'reset') {
      this.stopReader()
      this.segment = null
    } else if (event.type === 'state') {
      this.state = event.state
      if (this.state.active || this.state.awaiting) this.userTurn = false
      if (!this.state.active && !this.state.awaiting) this.finishReader()
      this.settleTurn()
    } else if (event.type === 'reply' && !this.paused) {
      if (this.segment !== null && this.segment !== event.segment && this.readerStarted) readAloud.nextStreamSegment(this.streamId)
      this.segment = event.segment
      if (event.text) {
        this.userTurn = false
        if (!this.readerStarted) {
          this.readerStarted = true
          readAloud.beginStream(this.streamId)
        }
        readAloud.pushStream(this.streamId, event.text)
      }
      if (event.complete) this.finishReader()
    }
    this.publish()
  }

  private finishReader() {
    if (!this.readerStarted) return
    this.readerStarted = false
    readAloud.endStream(this.streamId)
  }

  private stopReader() {
    const ownsReader = this.readerStarted || readAloud.getSnapshot().activeId === this.streamId
    this.readerStarted = false
    if (ownsReader) readAloud.stop()
  }

  private settleTurn() {
    if (this.paused || this.state.active || this.state.awaiting || readAloud.getSnapshot().activeId === this.streamId) return
    if (!this.userTurn) {
      this.userTurn = true
      if (this.listener?.utterance.trim() && Date.now() - this.lastHeardAt > KEEP_RECENT_WORDS_MS) void this.listener.discard()
    }
  }

  private samplePlayback(): boolean {
    if (readAloud.isAudible()) this.lastAudioAt = Date.now()
    const next = Date.now() - this.lastAudioAt < PLAYBACK_RELEASE_MS
    const changed = next !== this.assistantSpeaking
    this.assistantSpeaking = next
    return changed
  }

  private publish() {
    if (this.closed) return
    const reader = readAloud.getSnapshot()
    const speaking = reader.activeId === this.streamId && reader.status === 'speaking'
    this.events.onSnapshot({
      phase: this.userTurn ? 'listening' : speaking ? 'speaking' : 'thinking',
      ready: this.ready, userSpeaking: this.userSpeaking, assistantSpeaking: this.assistantSpeaking,
      utterance: this.utterance,
      hold: { allowed: !this.paused && !this.userTurn, delayMs: this.state.toolsUsed ? 700 : 3000 },
    })
  }

  setPaused(paused: boolean) {
    if (this.closed || this.paused === paused) return
    this.paused = paused
    if (paused) {
      this.stopListener()
      this.finishReader()
    } else {
      this.segment = null
      void this.openListener()
      const held = this.held
      this.held = null
      if (held) void this.submit(held)
    }
    this.publish()
  }

  pressMic() {
    if (this.closed || this.paused) return
    if (this.userTurn) void this.sendUtterance()
    else this.interrupt()
  }

  private stopListener() {
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    clearTimeout(this.duckTimer)
    const listener = this.listener
    this.listener = null
    listener?.stop()
    this.userSpeaking = false
    this.ready = false
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.held = null
    this.unsubscribe?.()
    clearInterval(this.audioMeter)
    this.stopListener()
    this.stopReader()
  }
}
