import type { SttProvider } from '@shared/lib/config/settings'
import { DeepgramVoiceAgentAdapter } from './voice-agent-deepgram'
import { OpenAIVoiceAgentAdapter } from './voice-agent-openai'

export type { SttProvider }

// --- Types ---

/** Configuration passed when starting a Voice Agent session */
export interface VoiceAgentConfig {
  /** System prompt / instructions for the agent */
  systemPrompt: string
  /** Optional tools the agent can call */
  tools?: VoiceAgentTool[]
  /** Optional prior conversation messages for context (Improve Agent flow) */
  conversationContext?: { role: 'user' | 'assistant'; content: string }[]
  /** Optional voice selection (provider-specific) */
  voice?: string
  /** Optional greeting the agent speaks first */
  greeting?: string
}

export interface VoiceAgentTool {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
}

/** Events emitted by the Voice Agent adapter */
export type VoiceAgentEvent =
  | { type: 'connected' }
  | { type: 'user_speaking' }
  | { type: 'user_stopped_speaking' }
  | { type: 'agent_thinking' }
  | { type: 'agent_audio'; audio: ArrayBuffer }
  | { type: 'agent_audio_done' }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; final: boolean }
  | { type: 'function_call'; id: string; name: string; arguments: string }
  | { type: 'error'; message: string }
  | { type: 'disconnected' }

export type VoiceAgentEventCallback = (event: VoiceAgentEvent) => void

// --- Adapter Interface ---

/** Adapter interface for provider-specific Voice Agent WebSocket logic */
export interface VoiceAgentAdapter {
  /** Sample rate for input audio (16000 for Deepgram, 24000 for OpenAI) */
  readonly inputSampleRate: number
  /** Sample rate for output audio */
  readonly outputSampleRate: number

  /** Open WebSocket and configure the agent session */
  connect(token: string, config: VoiceAgentConfig): Promise<void>
  /** Send a chunk of audio from the microphone */
  sendAudio(chunk: ArrayBuffer): void
  /** Respond to a function call from the agent */
  respondToFunctionCall(callId: string, result: string): void
  /** Register event listener */
  onEvent(cb: VoiceAgentEventCallback): void
  /** Close the session */
  close(): void
}

// --- Factory ---

export function createVoiceAgentAdapter(provider: SttProvider): VoiceAgentAdapter {
  switch (provider) {
    case 'deepgram':
    case 'platform':
      return new DeepgramVoiceAgentAdapter()
    case 'openai':
      return new OpenAIVoiceAgentAdapter()
    default:
      throw new Error(`Unknown Voice Agent provider: ${provider}`)
  }
}
