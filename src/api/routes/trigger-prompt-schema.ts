import { z } from 'zod'

export const promptUpdateSchema = z.object({
  prompt: z.string().trim().min(1, 'prompt is required').max(50_000, 'prompt is too long'),
})

export type PromptUpdate = z.infer<typeof promptUpdateSchema>
