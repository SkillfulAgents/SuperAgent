import { z } from 'zod'

const nonEmptyString = z.string().trim().min(1, 'must be a non-empty string')

export const updateScheduledTaskInputSchema = z
  .object({
    task_id: nonEmptyString,
    schedule_expression: nonEmptyString.optional(),
    prompt: nonEmptyString.optional(),
  })
  .refine(
    (input) => input.schedule_expression !== undefined || input.prompt !== undefined,
    { message: 'pass schedule_expression and/or prompt' },
  )

export const updateWebhookTriggerInputSchema = z.object({
  trigger_id: nonEmptyString,
  prompt: nonEmptyString,
})

export type ScheduledTaskUpdateInput = z.infer<typeof updateScheduledTaskInputSchema>
export type WebhookTriggerUpdateInput = z.infer<typeof updateWebhookTriggerInputSchema>
