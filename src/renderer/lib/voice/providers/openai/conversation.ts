import { readAloud } from '../../services/read-aloud'
import { OpenAILiveConversation } from './live-session'
import type { VoiceTranscriptEntry } from '@shared/lib/voice/conversation-types'
import type { VoiceAgentEvent, VoiceAgentState, VoiceConversationAdapter, VoiceConversationContext, VoiceConversationEvents } from '../../contracts/conversation'

/** Adapts Live media/mapping to the same agent-event contract as the chained engine. */
export class OpenAILiveConversationAdapter implements VoiceConversationAdapter {
  readonly capabilities = { speechSpeed: false, spokenTranscript: true }
  private conversation: OpenAILiveConversation
  private state: VoiceAgentState = { active: false, awaiting: false, toolsUsed: false }
  private releaseAudio: (() => void) | null = null
  private ready = false
  private segment: number | null = null
  private paused = false
  private closed = false
  private userSpeaking = false
  private assistantSpeaking = false
  private utterance = ''
  private transcript: VoiceTranscriptEntry[] = []

  constructor(context: VoiceConversationContext, private events: VoiceConversationEvents) {
    this.conversation = new OpenAILiveConversation({
      onReady: () => { this.ready = true; this.publish() },
      onClosed: () => { this.releaseAudio?.(); this.releaseAudio = null; this.ready = false; this.publish() },
      onUtterance: (text) => { this.utterance = text; this.publish() },
      onTranscript: (entries) => { this.transcript = entries; this.publish() },
      onSpeaking: (value) => { this.assistantSpeaking = value; this.publish() },
      onInputSpeaking: (value) => { this.userSpeaking = value; this.publish() },
      onError: (message) => { if (!this.closed) this.events.onError(message) },
      onRequest: async (request) => {
        if (this.closed || this.paused) return false
        if (request.action !== 'message' && request.action !== 'cancel') return false
        const result = await this.events.onCommand(request.action === 'cancel'
          ? { type: 'cancel' } : { type: 'submit', text: request.text })
        return result.accepted
      },
    }, context.history, context.agentSlug)
  }

  get analyser() { return this.conversation.analyser }
  async start() {
    if (this.closed) return
    this.releaseAudio ??= readAloud.suspend()
    try { await this.conversation.start() } catch (error) { this.close(); throw error }
  }

  acceptAgentEvent(event: VoiceAgentEvent) {
    if (this.closed) return
    if (event.type === 'state') {
      this.state = event.state
      this.conversation.setBusy(this.state.active || this.state.awaiting)
    } else if (event.type === 'reset') {
      this.segment = null
      this.conversation.resetReply()
    } else if (event.type === 'reply') {
      if (this.segment !== null && this.segment !== event.segment) this.conversation.nextReplySegment()
      this.segment = event.segment
      this.conversation.updateReply(event.text, event.complete)
    } else if (event.type === 'error') {
      this.conversation.nextReplySegment()
      this.conversation.updateReply(`The agent reported an error: ${event.message}`, true)
    }
    this.publish()
  }

  setPaused(paused: boolean) { this.paused = paused; this.conversation.setPaused(paused); this.publish() }
  pressMic() { if (!this.closed && !this.paused) this.conversation.pressMic(this.state.active || this.assistantSpeaking) }
  close() { this.closed = true; this.conversation.close(); this.releaseAudio?.(); this.releaseAudio = null }

  private publish() {
    if (this.closed) return
    this.events.onSnapshot({
      phase: this.assistantSpeaking ? 'speaking' : !this.ready || this.state.active || this.state.awaiting ? 'thinking' : 'listening',
      ready: this.ready, userSpeaking: this.userSpeaking, assistantSpeaking: this.assistantSpeaking,
      utterance: this.utterance, transcript: this.transcript,
      hold: { allowed: this.ready && !this.paused && this.state.active, delayMs: 700 },
    })
  }
}
