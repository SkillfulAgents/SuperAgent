import { z } from 'zod'
import type { AgentCapabilitySettings } from '../config/capability-policy-schema'

import { voiceHistorySchema, type VoiceHistory } from './conversation-types'
import type { TtsVoiceInfo } from './tts-preferences'
export { voiceHistorySchema, type VoiceHistory, type VoiceTranscriptEntry } from './conversation-types'

/**
 * The part of the Live prompt that says when to speak. A person alone with the
 * app and a bot in a room need different answers; everything else (delegation,
 * capabilities, identity) is shared.
 */
export interface LiveConversationPolicy {
  /** Backchannels, interruption, who may be answered. */
  turnTaking: string
  /** How backend text and the completion cue turn into speech. */
  spokenUpdates: string
}

/** Application-owned commentary after all context for a backend turn has been sent. */
export const LIVE_TURN_COMPLETE_CUE = 'The backend agent has finished this turn.'

export const liveMappingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('request'),
    history: voiceHistorySchema,
    transcript: z.string().min(1).max(16000),
    previousRequest: z.string().max(4000),
    agentBusy: z.boolean(),
  }),
  z.object({ kind: z.literal('reply'), text: z.string().min(1).max(12000) }),
])
export type LiveMappingInput = z.infer<typeof liveMappingSchema>

export const liveRequestSchema = z.object({
  action: z.enum(['message', 'cancel', 'clarify', 'none']),
  text: z.string().max(4000),
})
export type LiveRequest = z.infer<typeof liveRequestSchema>

export interface LiveSessionAnswer {
  session: { id: string }
  transport: { type: 'webrtc'; sdp: string }
}

/**
 * Where the conversation is happening, when it is not a person alone with the
 * app. An integration that owns the session (a meeting, a shared channel)
 * describes it: the turn-taking policy that replaces the one-on-one rules,
 * and standing instructions about the place and who is there. The host
 * derives it from the session; the browser cannot claim one.
 */
export interface LiveConversationSetting {
  /** Replaces the one-on-one turn-taking and spoken-update rules. */
  policy: LiveConversationPolicy
  /** Appended to the prompt: the place, the model's name there, who is present. Plain prose. */
  instructions: string
  /** The provider's voice id to speak with; the provider falls back to its default for one it does not offer. */
  voice?: string
}

/** Loaded by the host after checking agent access; never accepted from the browser. */
export interface LiveAgentContext {
  name: string
  description?: string
  instructions: string
  capabilityPolicies: AgentCapabilitySettings
  setting?: LiveConversationSetting
}

/** Optional provider capability for delegated WebRTC conversations. */
export interface LiveConversationProvider {
  createLiveSession(sdp: string, history: VoiceHistory, agent?: LiveAgentContext): Promise<LiveSessionAnswer>
  mapLiveConversation(input: LiveMappingInput, signal?: AbortSignal): Promise<LiveRequest | { text: string }>
  closeLiveSession(id: string, apiKey?: string): Promise<void>
  /** The voices a Live session can speak with; the first is the default. Distinct from read-aloud voices. */
  getLiveVoices(): readonly TtsVoiceInfo[]
  /** The voice a session is created with: the requested one when offered, else the default. */
  resolveLiveVoice(requested?: string | null): string
}
