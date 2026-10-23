import { z } from 'zod'

export const CreatedAgentSchema = z.object({ slug: z.string().min(1) })
