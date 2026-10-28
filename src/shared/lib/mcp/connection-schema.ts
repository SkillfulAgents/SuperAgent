import { z } from 'zod'
import type { McpToolInfo } from './types'

export const mcpRefreshResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
})

const cachedToolSchema = z.object({
  name: z.string(),
  description: z.string().optional().catch(undefined),
  inputSchema: z.record(z.string(), z.unknown())
    .catch({ type: 'object', additionalProperties: true }),
})
const cachedToolsSchema = z.array(z.unknown())

/** A damaged entry must not hide the rest of a server's cached discovery. */
export function parseCachedMcpTools(json: string | null): McpToolInfo[] {
  if (!json) return []
  try {
    return normalizeCachedMcpTools(JSON.parse(json))
  } catch { return [] }
}

export function normalizeCachedMcpTools(value: unknown): McpToolInfo[] {
  const parsed = cachedToolsSchema.safeParse(value)
  if (!parsed.success) return []
  return parsed.data.flatMap(value => {
    const tool = cachedToolSchema.safeParse(value)
    return tool.success ? [tool.data] : []
  })
}
