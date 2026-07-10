import { z } from 'zod'

/**
 * Wire schema for GET /api/home-graph — the topology half of the home
 * connections graph, fetched in one request. Node identity data (agents,
 * connected accounts, remote MCPs) is NOT here: those come from their
 * existing global endpoints, which stay live via SSE/mutation invalidation.
 * Everything below is a load-time snapshot.
 *
 * The renderer parses responses with this schema at the fetch boundary; the
 * route builds its response from the inferred type so the two can't drift.
 */

export const homeGraphChatSchema = z.object({
  id: z.string(),
  agentSlug: z.string(),
  provider: z.string(),
  name: z.string().nullable(),
  status: z.enum(['active', 'paused', 'error', 'disconnected']),
  /** Live transport state (same isIntegrationConnected the connector page reads) */
  connected: z.boolean(),
  /** Chat sessions ever opened through this integration — "has it been used" */
  sessionCount: z.number(),
})

export const homeGraphWebhookSchema = z.object({
  id: z.string(),
  agentSlug: z.string(),
  triggerType: z.string(),
  name: z.string().nullable(),
  status: z.enum(['active', 'paused', 'cancelled', 'failed']),
  fireCount: z.number(),
})

export const homeGraphCronSchema = z.object({
  id: z.string(),
  agentSlug: z.string(),
  name: z.string().nullable(),
  scheduleExpression: z.string(),
  isRecurring: z.boolean(),
  status: z.enum(['pending', 'paused', 'executed', 'cancelled', 'failed']),
  executionCount: z.number(),
})

export const homeGraphSchema = z.object({
  /** agent ↔ connected-account mappings (whole junction, visible agents only) */
  accountLinks: z.array(z.object({ agentSlug: z.string(), accountId: z.string() })),
  /** agent ↔ remote-MCP mappings */
  mcpLinks: z.array(z.object({ agentSlug: z.string(), mcpId: z.string() })),
  chats: z.array(homeGraphChatSchema),
  webhooks: z.array(homeGraphWebhookSchema),
  crons: z.array(homeGraphCronSchema),
  /** x-agent invoke permissions (non-block, concrete target) */
  permissions: z.array(z.object({ caller: z.string(), target: z.string() })),
  /** Actual agent→agent session invocations, from session metadata */
  invocations: z.array(z.object({ caller: z.string(), target: z.string(), count: z.number() })),
  /** Proxied API calls per "agentSlug:accountId" (proxy audit log) */
  accountUsage: z.record(z.string(), z.number()),
  /** MCP calls per "agentSlug:mcpId" (MCP audit log) */
  mcpUsage: z.record(z.string(), z.number()),
})

export type HomeGraphData = z.infer<typeof homeGraphSchema>
export type HomeGraphChat = z.infer<typeof homeGraphChatSchema>
export type HomeGraphWebhook = z.infer<typeof homeGraphWebhookSchema>
export type HomeGraphCron = z.infer<typeof homeGraphCronSchema>
