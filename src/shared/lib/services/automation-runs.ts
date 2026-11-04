/**
 * The cron and webhook runs an agent's charts are drawn from, kept in the agent's
 * stored summary so the Home charts read rows and wake no agent. Taken from the
 * agent's session metadata each time its summary is built.
 */
import { MAX_ACTIVITY_DAYS } from '@shared/lib/types/activity'
import type { SessionMetadataMap } from '@shared/lib/types/agent'

export interface AutomationRun {
  sessionId: string
  createdAt?: string
  /**
   * 'running' only while the run's session was live when the summary was built: a run
   * that died without a result is 'failed'. Absent for runs from before outcomes were kept.
   */
  status?: 'running' | 'succeeded' | 'failed'
  scheduledTaskId?: string
  scheduledExecutionAt?: string
  webhookTriggerId?: string
  webhookInvocationCount?: number
}

/** A cron chart shows its latest slots; this keeps at least as many as any chart asks for. */
const RUNS_PER_CRON = MAX_ACTIVITY_DAYS
const DAY_MS = 24 * 60 * 60 * 1000

export function automationRunsOf(metadata: SessionMetadataMap, activeSessionIds: readonly string[], now: Date): AutomationRun[] {
  const active = new Set(activeSessionIds)
  const webhookSince = now.getTime() - MAX_ACTIVITY_DAYS * DAY_MS
  const runsByCron = new Map<string, AutomationRun[]>()
  const runs: AutomationRun[] = []
  for (const [sessionId, meta] of Object.entries(metadata)) {
    const status = meta.automationStatus === 'running' && !active.has(sessionId) ? 'failed' : meta.automationStatus
    const common = { sessionId, ...(meta.createdAt ? { createdAt: meta.createdAt } : {}), ...(status ? { status } : {}) }
    if (meta.scheduledTaskId && meta.scheduledExecutionAt) {
      const cronRuns = runsByCron.get(meta.scheduledTaskId) ?? []
      cronRuns.push({ ...common, scheduledTaskId: meta.scheduledTaskId, scheduledExecutionAt: meta.scheduledExecutionAt })
      runsByCron.set(meta.scheduledTaskId, cronRuns)
    } else if (meta.isWebhookExecution && meta.webhookTriggerId && meta.createdAt && Date.parse(meta.createdAt) >= webhookSince) {
      runs.push({
        ...common,
        webhookTriggerId: meta.webhookTriggerId,
        ...(meta.webhookInvocationCount === undefined ? {} : { webhookInvocationCount: meta.webhookInvocationCount }),
      })
    }
  }
  for (const cronRuns of runsByCron.values()) {
    cronRuns.sort((a, b) => b.scheduledExecutionAt!.localeCompare(a.scheduledExecutionAt!))
    runs.push(...cronRuns.slice(0, RUNS_PER_CRON))
  }
  return runs
}

/** The runs as the session metadata the chart builders read. */
export function automationRunsAsMetadata(runs: readonly AutomationRun[]): SessionMetadataMap {
  return Object.fromEntries(runs.map(({ sessionId, status, webhookTriggerId, ...rest }) => [sessionId, {
    ...rest,
    ...(status ? { automationStatus: status } : {}),
    ...(webhookTriggerId ? { isWebhookExecution: true, webhookTriggerId } : {}),
  }]))
}
