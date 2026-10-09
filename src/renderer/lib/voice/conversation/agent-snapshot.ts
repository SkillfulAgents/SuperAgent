import type { SessionExecution } from '@shared/lib/container/session-execution-schema'
import type { VoiceAgentSnapshot } from '../contracts/conversation'

interface AgentStream {
  isActive: boolean
  isWaitingBackground?: boolean
  streamingMessage: string | null
  activeStartTime: number | null
  streamingToolUses: readonly unknown[]
  error: string | null
  execution?: SessionExecution | null
}

export function toAgentSnapshot(stream: AgentStream): VoiceAgentSnapshot {
  const execution = stream.execution ?? null
  return {
    active: execution ? execution.phase === 'running' : stream.isActive && !stream.isWaitingBackground,
    background: execution
      ? execution.phase === 'waiting_background' || execution.phase === 'finishing'
      : stream.isWaitingBackground === true,
    text: stream.streamingMessage ?? '', startedAt: stream.activeStartTime ?? null,
    toolsRunning: (stream.streamingToolUses?.length ?? 0) > 0,
    error: stream.error ?? null, execution,
  }
}
