import { z } from 'zod'

export const taskEventSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), interactionId: z.string(),
  kind: z.enum(['invocation', 'status', 'context']), timestamp: z.string(),
  acknowledge: z.boolean().optional(),
  text: z.string(), title: z.string().optional(),
  replyTarget: z.record(z.string(), z.string()), payload: z.unknown(),
})
export const taskPublicationSchema = z.object({
  id: z.string().uuid(), kind: z.enum(['thought', 'response', 'error', 'elicitation']), body: z.string(),
})
export const taskRuntimeEventSchema = z.object({
  type: z.string(), text: z.string().optional(), error: z.string().optional(),
})

/** Decode persisted JSON at the boundary and report a stable, secret-free error. */
export function parseTaskJson<T>(schema: z.ZodType<T>, json: string): T {
  try { return schema.parse(JSON.parse(json)) } catch { throw new Error('Invalid persisted integration data') }
}
