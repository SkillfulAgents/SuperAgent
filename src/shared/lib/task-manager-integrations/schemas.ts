import { z } from 'zod'

export const taskEventSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), interactionId: z.string(),
  kind: z.enum(['invocation', 'status', 'context']), timestamp: z.string(),
  sourceCommentId: z.string().optional(),
  text: z.string(), title: z.string().optional(),
  replyTarget: z.record(z.string(), z.string()), payload: z.unknown(),
})
/** Decode persisted JSON at the boundary and report a stable, secret-free error. */
export function parseTaskJson<T>(schema: z.ZodType<T>, json: string): T {
  try { return schema.parse(JSON.parse(json)) } catch { throw new Error('Invalid persisted integration data') }
}
