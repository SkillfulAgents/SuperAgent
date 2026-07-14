import { z } from 'zod'
import type {
  AgentActivityStats,
  ConnectionActivityStats,
  CronActivityPoint,
  DailyActivityPoint,
} from './activity'

// Transport-boundary schemas for the /api/activity responses (project
// convention: validate JSON at the boundary instead of casting). Unlike the
// deliberately-lenient persisted-file schemas, these are strict: client and
// server ship in the same build, so a mismatch here is drift worth surfacing.

const dailyActivityPointSchema = z.object({
  date: z.string(),
  succeeded: z.number(),
  failed: z.number(),
}) satisfies z.ZodType<DailyActivityPoint>

const cronActivityPointSchema = z.object({
  scheduledAt: z.string(),
  status: z.enum(['succeeded', 'running', 'skipped', 'failed']),
}) satisfies z.ZodType<CronActivityPoint>

export const agentActivityStatsSchema = z.object({
  days: z.number(),
  generatedAt: z.string(),
  cronByTaskId: z.record(z.string(), z.array(cronActivityPointSchema)),
  webhookByTriggerId: z.record(z.string(), z.array(dailyActivityPointSchema)),
  connectionById: z.record(z.string(), z.array(dailyActivityPointSchema)),
}) satisfies z.ZodType<AgentActivityStats>

export const connectionActivityStatsSchema = z.object({
  days: z.number(),
  generatedAt: z.string(),
  connectionById: z.record(z.string(), z.array(dailyActivityPointSchema)),
}) satisfies z.ZodType<ConnectionActivityStats>
