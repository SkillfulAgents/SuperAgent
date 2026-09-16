import { z } from 'zod'
import type { AgentCapabilitySettings } from '../config/capability-policy-schema'

import { voiceHistorySchema, type VoiceHistory } from './conversation-types'
export { voiceHistorySchema, type VoiceHistory, type VoiceTranscriptEntry } from './conversation-types'

export const liveMappingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('request'),
    history: voiceHistorySchema,
    transcript: z.string().min(1).max(16000),
    // Everything the user said since their last message was sent: the only source of the rewrite.
    // Absent from clients older than the rewrite pipe; the host then answers in the legacy shape.
    userWords: z.string().min(1).max(16000).optional(),
    previousRequest: z.string().max(4000),
    agentBusy: z.boolean(),
  }),
  z.object({ kind: z.literal('reply'), text: z.string().min(1).max(12000) }),
])
export type LiveMappingInput = z.infer<typeof liveMappingSchema>

/** A rewrite of the user's words, and whether it joins the running turn or replaces it. */
export const liveRequestSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  mode: z.enum(['interrupt', 'queue']),
})
export type LiveRequest = z.infer<typeof liveRequestSchema>

/**
 * The shape hosts returned before `mode`. A host still answers with it when the
 * client sent no `userWords`, and a client still accepts it from an older host.
 */
export const legacyLiveRequestSchema = z.object({
  action: z.enum(['message', 'cancel', 'clarify', 'none']),
  text: z.string().max(4000),
})
export type LegacyLiveRequest = z.infer<typeof legacyLiveRequestSchema>

export interface LiveSessionAnswer {
  session: { id: string }
  transport: { type: 'webrtc'; sdp: string }
}

/** Loaded by the host after checking agent access; never accepted from the browser. */
export interface LiveAgentContext {
  name: string
  description?: string
  instructions: string
  capabilityPolicies: AgentCapabilitySettings
}

/** Optional provider capability for delegated WebRTC conversations. */
export interface LiveConversationProvider {
  createLiveSession(sdp: string, history: VoiceHistory, agent?: LiveAgentContext): Promise<LiveSessionAnswer>
  mapLiveConversation(input: LiveMappingInput, signal?: AbortSignal): Promise<LiveRequest | LegacyLiveRequest | { text: string }>
  closeLiveSession(id: string, apiKey?: string): Promise<void>
}
