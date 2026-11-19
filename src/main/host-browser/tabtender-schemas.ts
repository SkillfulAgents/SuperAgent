/**
 * The parts of a Tab Tender server's answers (https://github.com/SkillfulAgents/tabtender,
 * docs/api.md) the Tab Tender host-browser provider reads, and the relay
 * record it keeps. Loose: the server may add fields.
 */
import { z } from 'zod'

export const tabtenderSessionSchema = z.object({
  id: z.string().min(1),
  /** 'starting' | 'running' | 'terminating' | 'terminated'. */
  status: z.string(),
  /** Named persistent profile; absent for an ephemeral session. */
  profile: z.string().nullish(),
  /**
   * The session's CDP WebSocket, built for the caller's address, carrying a
   * `?token=` that authorises this one session's CDP endpoint until it ends
   * (never the API key). Absent once terminated.
   */
  cdpUrl: z.string().min(1).nullish(),
}).loose()
export type TabtenderSession = z.infer<typeof tabtenderSessionSchema>

export const tabtenderSessionListSchema = z.object({
  sessions: z.array(tabtenderSessionSchema),
}).loose()

export const tabtenderHealthSchema = z.object({
  status: z.string(),
  browser: z.object({ available: z.boolean(), error: z.string().nullish() }).loose().nullish(),
}).loose()
export type TabtenderHealth = z.infer<typeof tabtenderHealthSchema>

/** Tab Tender's error body: `{ error: { code: 'profile_in_use', message } }`. */
export const tabtenderErrorSchema = z.object({
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).loose(),
}).loose()
