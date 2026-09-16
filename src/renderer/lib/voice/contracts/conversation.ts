import type { VoiceHistory, VoiceTranscriptEntry } from '@shared/lib/voice/conversation-types'

export type VoiceModePhase = 'listening' | 'thinking' | 'speaking'
export type { VoiceConversationEngine } from '@shared/lib/voice/conversation-types'

export type VoiceAgentCommand = { type: 'submit'; text: string } | { type: 'cancel' }
export type VoiceCommandResult = { accepted: true } | { accepted: false; error?: string }

/** Snapshot of the existing agent stream; protocol heuristics are confined to the coordinator. */
export interface VoiceAgentSnapshot {
  active: boolean
  text: string
  startedAt: number | null
  toolsRunning: boolean
  error: string | null
}
export interface VoiceAgentState {
  active: boolean
  awaiting: boolean
  toolsUsed: boolean
}
export type VoiceAgentEvent =
  | { type: 'state'; state: VoiceAgentState }
  | { type: 'reset' }
  | { type: 'reply'; segment: number; text: string; complete: boolean }
  | { type: 'error'; message: string }

export interface VoiceConversationSnapshot {
  phase: VoiceModePhase
  ready: boolean
  userSpeaking: boolean
  assistantSpeaking: boolean
  utterance: string
  transcript?: VoiceTranscriptEntry[]
  /** Provider turn-taking policy; execution activity itself comes from the coordinator. */
  hold: { allowed: boolean; delayMs: number }
}
export interface VoiceConversationEvents {
  onCommand(command: VoiceAgentCommand): Promise<VoiceCommandResult>
  onSnapshot(snapshot: VoiceConversationSnapshot): void
  onError(message: string | null): void
}
export interface VoiceConversationContext {
  sessionId: string
  history: VoiceHistory
}

/** Turn-taking bounds and leniency an engine asks of the coordinator. */
export interface VoiceTurnPolicy {
  /** How long to wait for the agent to confirm an interrupt. */
  interruptTimeoutMs: number
  /** How long a request may go without agent activity before the floor returns. */
  turnStartTimeoutMs: number
  /**
   * Chained speech keeps the original contract: an interrupt that cannot be
   * confirmed in time is not a reason to drop the words the person just said,
   * and a failed cancel is not reported. Live keeps strict ordering instead.
   */
  sendAfterFailedInterrupt: boolean
}

/** No agent API calls or stream subscriptions belong in implementations. */
export interface VoiceConversationAdapter {
  readonly capabilities: { speechSpeed: boolean; spokenTranscript: boolean }
  /** Omitted: the coordinator's strict defaults apply. */
  readonly turnPolicy?: Partial<VoiceTurnPolicy>
  readonly analyser: AnalyserNode | null
  start(): Promise<void>
  acceptAgentEvent(event: VoiceAgentEvent): void
  setPaused(paused: boolean): void
  pressMic(): void
  close(): void
}
