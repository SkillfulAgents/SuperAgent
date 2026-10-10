import type { SessionTurnOutcome } from '@shared/lib/container/session-turn-outcome-schema'
import type { VoiceAgentSnapshot } from '../contracts/conversation'

interface AgentStream {
  isActive: boolean
  isWaitingBackground?: boolean
  streamingMessage: string | null
  activeStartTime: number | null
  streamingToolUses: readonly unknown[]
  error: string | null
  turnOutcome?: SessionTurnOutcome | null
}

export function toAgentSnapshot(stream: AgentStream): VoiceAgentSnapshot {
  return {
    active: stream.isActive && !stream.isWaitingBackground,
    background: stream.isWaitingBackground === true,
    text: stream.streamingMessage ?? '', startedAt: stream.activeStartTime ?? null,
    toolsRunning: (stream.streamingToolUses?.length ?? 0) > 0,
    error: stream.error ?? null, turnOutcome: stream.turnOutcome ?? null,
  }
}
