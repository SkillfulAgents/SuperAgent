import { z } from 'zod'

export const transcriptImageSchema = z.object({
  mimeType: z.string().min(1),
  data: z.string().min(1),
})

export type TranscriptImage = z.infer<typeof transcriptImageSchema>

export const toolUseIdParamSchema = z.string().regex(/^[\w.-]{1,128}$/)

export const toolResultParamsSchema = z.object({
  toolUseId: toolUseIdParamSchema,
})

export const toolResultImageParamsSchema = toolResultParamsSchema.extend({
  index: z.coerce.number().int().min(0).max(50),
})

export const sessionToolResultSchema = z.object({
  result: z.unknown(),
  isError: z.boolean(),
})

export type SessionToolResult = z.infer<typeof sessionToolResultSchema>
