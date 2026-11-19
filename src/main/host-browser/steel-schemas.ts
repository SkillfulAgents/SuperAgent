/**
 * The parts of Steel's REST answers (https://api.steel.dev/v1) the Steel
 * host-browser provider reads. Loose: Steel adds fields freely.
 */
import { z } from 'zod'

export const steelSessionSchema = z.object({
  id: z.string().min(1),
  /** 'live' | 'released' | 'failed' today; any other value is treated as not live. */
  status: z.string(),
  /** CDP endpoint signed with a token scoped to this one session (not the API key). */
  websocketUrl: z.string().min(1),
  /** Set when the session loads or saves a profile (`persistProfile`). */
  profileId: z.string().min(1).nullish(),
}).loose()
export type SteelSession = z.infer<typeof steelSessionSchema>

export const steelProfileSchema = z.object({
  id: z.string().min(1),
  /** 'UPLOADING' while its first session runs and is saved, then 'READY' (or 'FAILED'). */
  status: z.string(),
  /** The session whose state the profile holds: it names a released session once that save has landed. */
  sourceSessionId: z.string().nullish(),
}).loose()
export type SteelProfile = z.infer<typeof steelProfileSchema>

/** A profile save under way (AppState `browser:steel:pending-save`, keyed by profile id): the session it is saved from. */
export const steelPendingSaveSchema = z.object({ sessionId: z.string().min(1) })

export const steelSessionListSchema = z.object({
  sessions: z.array(steelSessionSchema),
  nextCursor: z.string().nullish(),
}).loose()

/** Steel's error body, e.g. `{ code: 'profile_not_ready', message, retryable, retryAfterSeconds }`. */
export const steelErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  retryAfterSeconds: z.number().optional(),
}).loose()
