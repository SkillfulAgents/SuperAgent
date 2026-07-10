export const DEFAULT_ACTIVITY_DAYS = 14
export const MIN_ACTIVITY_DAYS = 7
export const MAX_ACTIVITY_DAYS = 30
export const DEFAULT_CRON_ACTIVITY_SLOTS = 18

export type ActivityOutcome = 'succeeded' | 'failed'

export interface DailyActivityPoint {
  /** UTC calendar day in YYYY-MM-DD form. */
  date: string
  succeeded: number
  failed: number
}

export type CronActivityStatus = 'succeeded' | 'skipped' | 'failed'

export interface CronActivityPoint {
  scheduledAt: string
  status: CronActivityStatus
}

export interface AgentActivityStats {
  days: number
  generatedAt: string
  cronByTaskId: Record<string, CronActivityPoint[]>
  webhookByTriggerId: Record<string, DailyActivityPoint[]>
  /** Unified connection row keys: `account-<id>` and `mcp-<id>`. */
  connectionById: Record<string, DailyActivityPoint[]>
}

export interface ConnectionActivityStats {
  days: number
  generatedAt: string
  connectionById: Record<string, DailyActivityPoint[]>
}
