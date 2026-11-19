import { z } from 'zod'

export const scheduleResumeInputSchema = z.object({
  wakeTime: z.string().optional(),
  summary: z.string().trim().optional(),
  note: z.string().optional(),
  timezone: z.string().optional(),
})

export type ScheduleResumeInput = z.infer<typeof scheduleResumeInputSchema>
