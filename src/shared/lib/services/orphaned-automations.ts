import { isAuthMode } from '@shared/lib/auth/mode'
import { captureMessage } from '@shared/lib/error-reporting'

import { pauseScheduledTasksCreatedBy } from './scheduled-task-service'
import { userExists } from './user-profile-service'
import { pauseWebhookTriggersCreatedBy } from './webhook-trigger-service'

export interface PausedAutomationCounts {
  scheduledTasks: number
  webhookTriggers: number
}

// created_by_user_id has no FK, so a deleted creator would leave tasks and
// triggers firing with no resolvable member (SUP-858). Pause everything they made.
export async function pauseAutomationsForUser(userId: string): Promise<PausedAutomationCounts> {
  const [scheduledTasks, webhookTriggers] = await Promise.all([
    pauseScheduledTasksCreatedBy(userId),
    pauseWebhookTriggersCreatedBy(userId),
  ])
  return { scheduledTasks, webhookTriggers }
}

/** True when an automation's creator no longer exists. Auth mode only. */
export function isOrphanedCreator(createdByUserId: string | null | undefined): createdByUserId is string {
  return isAuthMode() && !!createdByUserId && !userExists(createdByUserId)
}

// Runtime guard for rows orphaned before the user-delete hook existed.
export async function pauseOrphanedAutomations(
  createdByUserId: string,
  source: 'scheduled_task' | 'webhook_trigger',
  extra: Record<string, unknown>,
): Promise<PausedAutomationCounts> {
  const counts = await pauseAutomationsForUser(createdByUserId)
  console.warn(
    `[automations] creator ${createdByUserId} no longer exists; paused ${counts.scheduledTasks} task(s) and ${counts.webhookTriggers} trigger(s)`,
  )
  captureMessage('automation creator no longer exists; paused', {
    level: 'warning',
    tags: { area: 'automations', op: `orphaned_creator.${source}` },
    extra: { createdByUserId, ...counts, ...extra },
  })
  return counts
}
