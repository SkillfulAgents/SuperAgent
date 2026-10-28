import { z } from 'zod'

export const crashMarkerEntrySchema = z.object({
  timestamp: z.string(),
  type: z.enum(['uncaughtException', 'unhandledRejection']),
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
})

export const crashMarkerSchema = z.object({
  version: z.literal(1),
  appVersion: z.string(),
  // Incremented before each delivery attempt so a crash-looping app can't
  // retry the same marker forever.
  reportAttempts: z.number().int().nonnegative(),
  entries: z.array(crashMarkerEntrySchema).min(1),
})

export type CrashMarkerEntry = z.infer<typeof crashMarkerEntrySchema>
export type CrashMarker = z.infer<typeof crashMarkerSchema>
