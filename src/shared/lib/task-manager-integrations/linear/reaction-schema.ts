import { z } from 'zod'

export const reactionResultSchema = z.object({ reactionCreate: z.object({ success: z.boolean() }) })
