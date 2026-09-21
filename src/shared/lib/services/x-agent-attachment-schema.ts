import { z } from 'zod'

export const MAX_X_AGENT_ATTACHMENTS = 10
export const MAX_X_AGENT_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_X_AGENT_ATTACHMENTS_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

export const xAgentAttachmentPathSchema = z.string().min(1).max(4096)

export const xAgentAttachmentsSchema = z
  .array(xAgentAttachmentPathSchema)
  .max(MAX_X_AGENT_ATTACHMENTS)

export const xAgentDownloadFileBodySchema = z.object({
  slug: z.string().min(1),
  sessionId: z.string().min(1),
  deliveryId: z.string().min(1),
})
