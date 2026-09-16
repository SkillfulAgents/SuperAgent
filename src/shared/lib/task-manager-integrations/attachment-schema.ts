import { z } from 'zod'

export const MAX_TASK_ATTACHMENTS = 5
export const MAX_TASK_ATTACHMENT_BYTES = 10 * 1024 * 1024
const filenameSchema = z.string().trim().min(1).max(255).refine(value => !/[\\/]/.test(value) && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127), 'Use a filename without directory separators or control characters')
export const taskReplyAttachmentSchema = z.object({
  path: z.string().min(1).max(4096).describe('Existing file in this agent’s workspace, e.g. /workspace/output/chart.png.'),
  filename: filenameSchema.optional(),
  caption: z.string().trim().max(1000).optional(),
}).strict()
export const taskReplySchema = z.object({
  body: z.string().trim().min(1).max(12000),
  attachments: z.array(taskReplyAttachmentSchema).max(MAX_TASK_ATTACHMENTS)
    .describe('Files to include in the final comment: up to 5 files, 10 MiB each. Images are embedded; other files are linked.').optional(),
}).strict()

/** Host-created snapshot and upload receipt. Never accepted from tool input. */
export const taskAttachmentSchema = z.object({
  id: z.string().uuid(), filename: filenameSchema, caption: z.string().max(1000).optional(),
  contentType: z.string().min(1), size: z.number().int().min(0).max(MAX_TASK_ATTACHMENT_BYTES),
  assetUrl: z.string().url().refine(value => value.startsWith('https://')).optional(),
})
export type TaskReplyAttachment = z.infer<typeof taskReplyAttachmentSchema>
export type TaskAttachment = z.infer<typeof taskAttachmentSchema>
