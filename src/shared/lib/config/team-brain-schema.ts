import { z } from 'zod'

/** The workspace's one Team Brain: its agent and its drive. */
export const teamBrainRecordSchema = z.object({ agentSlug: z.string().min(1), volumeId: z.string().min(1) }).strict()
export type TeamBrainRecord = z.infer<typeof teamBrainRecordSchema>
