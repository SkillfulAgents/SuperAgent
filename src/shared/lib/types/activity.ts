export const DEFAULT_ACTIVITY_DAYS = 14
export const MIN_ACTIVITY_DAYS = 7
export const MAX_ACTIVITY_DAYS = 30
/**
 * Cron slots track the daily window so the two spark charts render the same
 * number of bars — they sit side by side in the same rows, and mismatched slot
 * counts made them read as two different components. Note the unit differs:
 * this is N scheduled runs (however far back the schedule reaches), not N days.
 */
export const DEFAULT_CRON_ACTIVITY_SLOTS = DEFAULT_ACTIVITY_DAYS

export type ActivityOutcome = 'succeeded' | 'failed'

export interface DailyActivityPoint {
  /** UTC calendar day in YYYY-MM-DD form. */
  date: string
  succeeded: number
  failed: number
}

export type CronActivityStatus = 'succeeded' | 'running' | 'skipped' | 'failed'

export interface CronActivityPoint {
  scheduledAt: string
  status: CronActivityStatus
}

export interface AgentActivityStats {
  days: number
  generatedAt: string
  cronByTaskId: Record<string, CronActivityPoint[]>
  webhookByTriggerId: Record<string, DailyActivityPoint[]>
  inboundXAgent: {
    total: number
    lastInvokedAt: string | null
    activity: DailyActivityPoint[]
  }
  /** Unified connection row keys: `account-<id>` and `mcp-<id>`. */
  connectionById: Record<string, DailyActivityPoint[]>
}

export interface ConnectionActivityStats {
  days: number
  generatedAt: string
  connectionById: Record<string, DailyActivityPoint[]>
}
