import { z } from 'zod'

export const meetingSpeakerChangesSchema = z.array(z.object({ at: z.number(), name: z.string() })).max(64)
export type MeetingSpeakerChanges = z.infer<typeof meetingSpeakerChangesSchema>
