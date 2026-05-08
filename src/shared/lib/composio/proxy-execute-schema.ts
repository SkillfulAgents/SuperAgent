import { z } from 'zod'

export const ProxyExecuteParameterSchema = z.object({
  name: z.string(),
  value: z.string(),
  type: z.enum(['query', 'header']),
})

export const ProxyExecuteBinaryBodySchema = z.union([
  z.object({ url: z.string() }),
  z.object({ base64: z.string(), content_type: z.string() }),
])

export const ProxyExecuteResponseSchema = z.object({
  status: z.number(),
  data: z.unknown(),
  headers: z.record(z.string(), z.string()).default({}),
  binary_data: z
    .object({
      url: z.string(),
      content_type: z.string(),
      size: z.number(),
      expires_at: z.string(),
    })
    .optional(),
})

export type ProxyExecuteResponse = z.infer<typeof ProxyExecuteResponseSchema>
