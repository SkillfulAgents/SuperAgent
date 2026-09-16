import { z } from 'zod'

export const xAgentErrorResponseSchema = z.object({
  error: z.string().optional(),
})

export const listAgentsResultSchema = z.object({
  agents: z.array(z.object({
    slug: z.string(),
    name: z.string(),
    description: z.string().optional(),
  })),
})

export const createAgentResultSchema = z.object({
  slug: z.string(),
  name: z.string(),
})

export const invokeResultSchema = z.object({
  sessionId: z.string(),
  status: z.enum(['running', 'completed']),
  lastMessage: z.string().optional(),
  error: z.string().optional(),
})

export const getSessionsResultSchema = z.object({
  sessions: z.array(z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    lastActivityAt: z.string(),
    messageCount: z.number().int().nonnegative(),
    isRunning: z.boolean(),
  })),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
})

export const deliveredFileSchema = z.object({
  deliveryId: z.string(),
  filename: z.string(),
  description: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})

export const transcriptResultSchema = z.object({
  status: z.enum(['running', 'idle', 'awaiting_input']),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
    toolName: z.string().optional(),
  })),
  total: z.number().int().nonnegative(),
  deliveredFiles: z.array(deliveredFileSchema).default([]),
})

export type InvokeResult = z.infer<typeof invokeResultSchema>
export type TranscriptResult = z.infer<typeof transcriptResultSchema>
